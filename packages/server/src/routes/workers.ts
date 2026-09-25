import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { v4 as uuid } from 'uuid';
import {
  isValidAgentType,
  isValidMaxConcurrency,
  MAX_DESCRIPTION_LENGTH,
  MAX_GROUP_CHILDREN,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_MAX_NAME_LENGTH,
  WORKER_STALE_AFTER_MS,
  WORKER_TASK_LEASE_MS,
} from '@ai-agent-board/shared/constants.js';
import type { AgentEvent, AgentType, Task, Worker } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { WorkerRegistration, WorkerRepository } from '../repositories/worker-types.js';
import { authenticatedWorker, claimTokenHash, workerAuth } from '../middleware/worker-auth.js';
import { asyncHandler, broadcastTaskUpdate, broadcastWorkerUpdate, toWorkerTaskAssignment } from './helpers.js';

const COMMAND_POLL_LIMIT_DEFAULT = 20;
const COMMAND_POLL_LIMIT_MAX = 100;

function publicWorker(worker: Worker & { readonly tokenHash?: string }): Worker {
  const { tokenHash: _tokenHash, ...result } = worker;
  return result;
}

function tokenHash(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: crypto.createHash('sha256').update(raw).digest('hex') };
}

function taskBelongs(task: Task | undefined, workerId: string): task is Task {
  return !!task && task.assignedWorkerId === workerId;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function normalizeLoopbackBridgeUrl(value: unknown, expectedTaskId: string): string | null {
  if (!TASK_ID_PATTERN.test(expectedTaskId)) return null;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (!isLoopback) return null;
  if (!parsed.port) return null;
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 2 || segments[0] !== 'session') return null;
  const taskIdInPath = decodeURIComponent(segments[1] ?? '');
  if (taskIdInPath !== expectedTaskId || !TASK_ID_PATTERN.test(taskIdInPath)) return null;
  return `${parsed.protocol}//${parsed.host}/session/${encodeURIComponent(taskIdInPath)}`;
}

function commandPollLimit(req: Request): number {
  const value = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) return COMMAND_POLL_LIMIT_DEFAULT;
  return Math.min(parsed, COMMAND_POLL_LIMIT_MAX);
}

export function createWorkersRouter(tasks: TaskRepository, workers: WorkerRepository): Router {
  const router = Router();
  const taskId = (req: Request): string => {
    const parameter = req.params.taskId;
    return typeof parameter === 'string' ? parameter : parameter[0];
  };

  router.post('/register', asyncHandler(async (req: Request, res: Response) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const agentTypes = req.body.agentTypes;
    const maxConcurrentTasks = req.body.maxConcurrentTasks ?? 1;
    if (!name || name.length > WORKER_MAX_NAME_LENGTH) {
      res.status(400).json({ error: 'name is required and must be at most 100 characters' });
      return;
    }
    if (!Array.isArray(agentTypes) || agentTypes.length === 0 || !agentTypes.every(isValidAgentType)) {
      res.status(400).json({ error: 'agentTypes must contain supported agent types' });
      return;
    }
    if (!isValidMaxConcurrency(maxConcurrentTasks, MAX_GROUP_CHILDREN)) {
      res.status(400).json({ error: 'maxConcurrentTasks must be an integer between 1 and 20' });
      return;
    }
    if (req.body.hostname !== undefined && typeof req.body.hostname !== 'string') {
      res.status(400).json({ error: 'hostname must be a string' });
      return;
    }
    if (req.body.version !== undefined && typeof req.body.version !== 'string') {
      res.status(400).json({ error: 'version must be a string' });
      return;
    }

    const now = Date.now();
    const credentials = tokenHash();
    const registration: WorkerRegistration = {
      id: uuid(),
      name,
      tokenHash: credentials.hash,
      agentTypes: agentTypes as AgentType[],
      maxConcurrentTasks,
      registeredAt: now,
      ...(req.body.hostname ? { hostname: req.body.hostname } : {}),
      ...(req.body.version ? { version: req.body.version } : {}),
    };
    const worker = await workers.register(registration);
    broadcastWorkerUpdate(worker);
    res.json({
      worker: publicWorker(worker),
      token: credentials.raw,
      heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
      staleAfterMs: WORKER_STALE_AFTER_MS,
    });
  }));

  router.use('/me', workerAuth(workers));

  router.post('/me/heartbeat', asyncHandler(async (req: Request, res: Response) => {
    const worker = authenticatedWorker(res);
    const now = Date.now();
    const currentTaskId = req.body.currentTaskId;
    if (currentTaskId !== undefined && typeof currentTaskId !== 'string') {
      res.status(400).json({ error: 'currentTaskId must be a string' });
      return;
    }
    if (currentTaskId) {
      const task = await tasks.getById(currentTaskId);
      if (!taskBelongs(task, worker.id)) {
        res.status(403).json({ error: 'task is not assigned to this worker' });
        return;
      }
      const claim = claimTokenHash(req);
      if (!claim || !await tasks.renewWorkerLease(task.id, worker.id, claim, now, WORKER_TASK_LEASE_MS)) {
        res.status(409).json({ error: 'task claim is expired or invalid' });
        return;
      }
    }
    const updated = await workers.heartbeat(worker.id, now);
    if (!updated) {
      res.status(404).json({ error: 'worker not found' });
      return;
    }
    // Only broadcast on a status transition (e.g. offline -> online after a
    // stale sweep) so routine 15s heartbeats don't spam every connected
    // client. Board UIs otherwise only learn a worker came online on their
    // next page load / WS-reconnect refetch, which silently hides newly
    // registered or recovered workers from the task-assignment dropdown.
    if (updated.status !== worker.status) {
      broadcastWorkerUpdate(updated);
    }
    res.json({ worker: publicWorker(updated) });
  }));

  router.get('/me/assignments', asyncHandler(async (_req: Request, res: Response) => {
    const worker = authenticatedWorker(res);
    res.json({ tasks: (await tasks.getWorkerAssignments(worker.id, Date.now())).map(toWorkerTaskAssignment) });
  }));

  router.post('/me/tasks/:taskId/claim', asyncHandler(async (req: Request, res: Response) => {
    const worker = authenticatedWorker(res);
    const task = await tasks.getById(taskId(req));
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (!taskBelongs(task, worker.id)) {
      res.status(403).json({ error: 'task is not assigned to this worker' });
      return;
    }
    const claim = tokenHash();
    const now = Date.now();
    const claimed = await tasks.claimWorkerTask(task.id, worker.id, claim.hash, now, WORKER_TASK_LEASE_MS);
    if (!claimed) {
      res.status(409).json({ error: 'task is already claimed or not eligible' });
      return;
    }
    await workers.clearTaskCommands(task.id);
    res.json({ task: toWorkerTaskAssignment(claimed), leaseExpiresAt: now + WORKER_TASK_LEASE_MS, claimToken: claim.raw });
  }));

  router.post('/me/tasks/:taskId/session', asyncHandler(async (req: Request, res: Response) => {
    const worker = authenticatedWorker(res);
    const task = await tasks.getById(taskId(req));
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (!taskBelongs(task, worker.id)) {
      res.status(403).json({ error: 'task is not assigned to this worker' });
      return;
    }
    const claim = claimTokenHash(req);
    const now = Date.now();
    if (!claim || !await tasks.isWorkerClaimValid(task.id, worker.id, claim, now)) {
      res.status(409).json({ error: 'task claim is invalid' });
      return;
    }
    const sessionId = typeof req.body.sessionId === 'string' ? req.body.sessionId.trim() : '';
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId must be a non-empty string' });
      return;
    }
    const baseUrl = normalizeLoopbackBridgeUrl(req.body.baseUrl, task.id);
    if (!baseUrl) {
      res.status(400).json({ error: 'baseUrl must be a loopback bridge URL matching /session/:taskId with explicit port and no query/hash/userinfo' });
      return;
    }
    await workers.registerTaskSession(task.id, sessionId, baseUrl, now);
    const renewed = await tasks.renewWorkerLease(task.id, worker.id, claim, now, WORKER_TASK_LEASE_MS);
    if (!renewed) {
      res.status(409).json({ error: 'task claim is expired' });
      return;
    }
    res.json({ success: true });
  }));

  router.get('/me/tasks/:taskId/commands', asyncHandler(async (req: Request, res: Response) => {
    const worker = authenticatedWorker(res);
    const task = await tasks.getById(taskId(req));
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (!taskBelongs(task, worker.id)) {
      res.status(403).json({ error: 'task is not assigned to this worker' });
      return;
    }
    const claim = claimTokenHash(req);
    const now = Date.now();
    if (!claim || !await tasks.isWorkerClaimValid(task.id, worker.id, claim, now)) {
      res.status(409).json({ error: 'task claim is invalid' });
      return;
    }
    const renewed = await tasks.renewWorkerLease(task.id, worker.id, claim, now, WORKER_TASK_LEASE_MS);
    if (!renewed) {
      res.status(409).json({ error: 'task claim is expired' });
      return;
    }
    const commands = await workers.claimTaskCommands(task.id, commandPollLimit(req));
    res.json({ commands });
  }));

  router.post('/me/tasks/:taskId/events', asyncHandler(async (req: Request, res: Response) => {
    const worker = authenticatedWorker(res);
    const task = await tasks.getById(taskId(req));
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (!taskBelongs(task, worker.id)) {
      res.status(403).json({ error: 'task is not assigned to this worker' });
      return;
    }
    const claim = claimTokenHash(req);
    if (!claim || !await tasks.isWorkerClaimValid(task.id, worker.id, claim, Date.now())) {
      res.status(409).json({ error: 'task claim is invalid' });
      return;
    }
    const event = req.body as AgentEvent;
    if (
      event.taskId !== task.id
      || typeof event.id !== 'string'
      || typeof event.type !== 'string'
      || typeof event.content !== 'string'
      || typeof event.timestamp !== 'number'
    ) {
      res.status(400).json({ error: 'invalid agent event' });
      return;
    }
    await tasks.insertEvent(event);
    const renewed = await tasks.renewWorkerLease(task.id, worker.id, claim, Date.now(), WORKER_TASK_LEASE_MS);
    if (!renewed) {
      res.status(409).json({ error: 'task claim is expired' });
      return;
    }
    const { broadcast } = await import('../websocket.js');
    broadcast({ type: 'agent_event', payload: event });
    res.json({ success: true });
  }));

  router.post('/me/tasks/:taskId/complete', asyncHandler(async (req: Request, res: Response) => {
    const worker = authenticatedWorker(res);
    const task = await tasks.getById(taskId(req));
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (!taskBelongs(task, worker.id)) {
      res.status(403).json({ error: 'task is not assigned to this worker' });
      return;
    }
    const status = req.body.status;
    if (status !== 'complete' && status !== 'failed' && status !== 'awaiting_input') {
      res.status(400).json({ error: 'status must be complete, failed, or awaiting_input' });
      return;
    }
    const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
    const sessionId = typeof req.body.sessionId === 'string' ? req.body.sessionId.trim() : '';
    if (status === 'awaiting_input' && (!question || question.length > MAX_DESCRIPTION_LENGTH)) {
      res.status(400).json({ error: `awaiting_input requires a question of at most ${MAX_DESCRIPTION_LENGTH} characters` });
      return;
    }
    const claim = claimTokenHash(req);
    if (!claim) {
      res.status(409).json({ error: 'task claim is invalid' });
      return;
    }
    const now = Date.now();
    const completed = await tasks.completeWorkerTask(
      task.id,
      worker.id,
      claim,
      status === 'awaiting_input' ? 'awaiting_clarification' : status,
      now,
      typeof req.body.summary === 'string' ? req.body.summary : undefined,
      typeof req.body.error === 'string' ? req.body.error : undefined,
    );
    if (!completed) {
      res.status(409).json({ error: 'task claim is expired or invalid' });
      return;
    }
    await workers.clearTaskSessions(task.id);
    await workers.clearTaskCommands(task.id);

    // Mirror the in-process lifecycle (makeStatusCallback): finished work goes
    // to Review, a blocking question parks the task in Pending, and a failure
    // never leaves it stranded in Pending.
    let updates: Partial<Task>;
    if (status === 'awaiting_input') {
      const clarificationRequest = {
        requestId: uuid(),
        // The board requires a session id to accept an answer; runners that
        // cannot expose one resume with carried-over context instead.
        sessionId: sessionId || `worker-task:${task.id}`,
        prompt: question,
        timestamp: now,
      };
      updates = { columnId: 'pending', completedAt: undefined, clarificationRequest, clarificationAnswer: null };
      const event: AgentEvent = {
        id: uuid(),
        taskId: task.id,
        type: 'command',
        content: question,
        timestamp: now,
        metadata: { clarification_request: { requestId: clarificationRequest.requestId, prompt: question, timestamp: now } },
      };
      await tasks.insertEvent(event);
      const { broadcast } = await import('../websocket.js');
      broadcast({ type: 'agent_event', payload: event });
    } else {
      updates = { clarificationRequest: null, clarificationAnswer: null };
      if (status === 'complete') updates.columnId = 'review';
      else if (completed.columnId === 'pending') updates.columnId = 'in-progress';
    }
    const updated = await tasks.update(task.id, updates) ?? completed;
    broadcastTaskUpdate(updated);
    res.json({ task: toWorkerTaskAssignment(updated) });
  }));

  router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    res.json((await workers.list()).map(publicWorker));
  }));

  return router;
}
