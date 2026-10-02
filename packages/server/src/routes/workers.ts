import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { v4 as uuid } from 'uuid';
import {
  isValidAgentType,
  isValidMaxConcurrency,
  MAX_DESCRIPTION_LENGTH,
  MAX_GROUP_CHILDREN,
  MAX_PENDING_WORK_REQUESTS,
  MAX_TITLE_LENGTH,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_MAX_NAME_LENGTH,
  WORKER_STALE_AFTER_MS,
  WORKER_TASK_LEASE_MS,
} from '@ai-agent-board/shared/constants.js';
import type { AgentEvent, AgentType, Task, Worker } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { WorkerRegistration, WorkerRepository } from '../repositories/worker-types.js';
import type { EnrollmentCodeRepository } from '../repositories/enrollment-code-types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import { authenticatedWorker, claimTokenHash, workerAuth } from '../middleware/worker-auth.js';
import { countPendingWorkRequests, withWorkRequestLock } from '../services/work-requests.js';
import { asyncHandler, broadcastTaskUpdate, broadcastWorkerRemove, broadcastWorkerUpdate, toWorkerTaskAssignment } from './helpers.js';

const COMMAND_POLL_LIMIT_DEFAULT = 20;
const COMMAND_POLL_LIMIT_MAX = 100;
const WORKER_EVENT_RATE_LIMIT_MAX = 100;
const WORKER_EVENT_RATE_LIMIT_WINDOW_MS = 60_000;
const ENROLLMENT_CODE_TTL_MS = 15 * 60 * 1000;
const VALID_AGENT_EVENT_TYPES: ReadonlySet<AgentEvent['type']> = new Set([
  'thinking', 'tool_call', 'file_read', 'file_write', 'file_edit', 'command',
  'command_output', 'output', 'test_result', 'request_work', 'error', 'complete',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validWorkerEventMetadata(value: unknown): value is NonNullable<AgentEvent['metadata']> {
  if (value === undefined) return true;
  if (!isPlainRecord(value)) return false;
  const stringKeys = new Set(['file', 'fileEventType', 'language', 'command', 'diff', 'error']);
  const nonNegativeNumberKeys = new Set(['duration', 'inputTokens', 'outputTokens', 'costUsd']);
  for (const [key, item] of Object.entries(value)) {
    if (stringKeys.has(key) && typeof item === 'string' && item.length <= MAX_DESCRIPTION_LENGTH) continue;
    if (key === 'agentType' && isValidAgentType(item)) continue;
    if (nonNegativeNumberKeys.has(key) && typeof item === 'number' && Number.isFinite(item) && item >= 0) continue;
    if ((key === 'clarification_request' || key === 'clarification_answer') && isPlainRecord(item)) continue;
    if (key === 'workRequest' && validWorkRequest(item)) continue;
    return false;
  }
  return true;
}

function validWorkRequest(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const { title, description, agentType } = value;
  return typeof title === 'string'
    && title.trim().length > 0
    && title.length <= MAX_TITLE_LENGTH
    && typeof description === 'string'
    && description.length <= MAX_DESCRIPTION_LENGTH
    && isValidAgentType(agentType);
}

function workerEventRateLimited(timestamps: Map<string, { startedAt: number; count: number }>, workerId: string): boolean {
  const now = Date.now();
  const current = timestamps.get(workerId);
  if (!current || now - current.startedAt >= WORKER_EVENT_RATE_LIMIT_WINDOW_MS) {
    timestamps.set(workerId, { startedAt: now, count: 1 });
    return false;
  }
  if (current.count >= WORKER_EVENT_RATE_LIMIT_MAX) return true;
  current.count += 1;
  return false;
}

type UsageTotals = { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
type UsageTask = { taskId: string; totals: UsageTotals };
type UsageProject = { projectId: string; totals: UsageTotals; tasks: UsageTask[] };
type UsageWorker = { workerId: string; workerName: string; totals: UsageTotals; projects: UsageProject[] };

function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
}

function addUsageTotals(target: UsageTotals, source: UsageTotals): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
  target.costUsd += source.costUsd;
}

function usageFromEvent(event: AgentEvent): UsageTotals | undefined {
  const metadata = event.metadata;
  const inputTokens = metadata?.inputTokens ?? 0;
  const outputTokens = metadata?.outputTokens ?? 0;
  const costUsd = metadata?.costUsd ?? 0;
  if (!inputTokens && !outputTokens && !costUsd) return undefined;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUsd };
}

function publicWorker(worker: Worker & { readonly tokenHash?: string; readonly tokenIssuedAt?: number }): Worker {
  const { tokenHash: _tokenHash, tokenIssuedAt: _tokenIssuedAt, hostname: _hostname, ...result } = worker;
  return result;
}

function tokenHash(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: crypto.createHash('sha256').update(raw).digest('hex') };
}

function taskBelongs(task: Task | undefined, workerId: string): task is Task {
  return !!task && task.assignedWorkerId === workerId;
}

function consentValues(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 100)) return undefined;
  return [...new Set(value.map((item) => item.trim().toLowerCase()))];
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

/**
 * A run started from Review is a review, not an implementation. A pass keeps
 * the task in Review with the findings as its summary; requested changes send
 * it back to In Progress (idle) so the next run implements them. The caller
 * only invokes this once a reviewVerdict has actually been reported — a
 * review that fails to produce one is settled as an ordinary completion, not
 * routed here (see the reviewVerdict-presence check where this is called).
 */
async function settleReviewRun(
  tasks: TaskRepository,
  completed: Task,
  status: 'complete' | 'failed',
  verdict: 'pass' | 'changes_requested',
): Promise<Task> {
  const now = Date.now();
  let updates: Partial<Task>;
  let content: string;
  if (status === 'complete' && verdict === 'pass') {
    updates = { columnId: 'review' };
    content = `Review passed.\n\n${completed.summary ?? ''}`.trim();
  } else if (status === 'complete' && verdict === 'changes_requested') {
    // completeWorkerTask() already clears run_requested_at/run_claimed_at/
    // worker_claim_token_hash on every completion (see its comment in
    // sqlite.ts/postgres.ts — that is the actual fix for the unattended
    // re-run root cause), so update() below re-reading and re-persisting
    // `completed`'s fields can't resurrect a stale run_requested_at here.
    // Moving to 'idle' is therefore safe: nothing left on the row makes this
    // task match getWorkerAssignments' predicate until a human re-runs it.
    updates = { columnId: 'in-progress', agentStatus: 'idle', startedAt: undefined, completedAt: undefined };
    content = `Review requested changes; task moved back to In Progress.\n\n${completed.summary ?? ''}`.trim();
  } else {
    // status === 'failed' (a verdict was still reported, e.g. alongside a
    // partial-failure report). completeWorkerTask() already wrote agent_status
    // = 'failed' directly, so re-asserting it here is a same-state write, not
    // a transition — it never goes through 'complete' first. (Note:
    // VALID_AGENT_STATUS_TRANSITIONS/canTransitionAgentStatus are not actually
    // enforced anywhere at runtime — canTransitionAgentStatus is currently
    // unused — so this is a design invariant we maintain by convention, not
    // a guard the code would otherwise reject.)
    const reason = 'Review failed.';
    updates = { columnId: 'review', agentStatus: 'failed', summary: completed.summary ? `${reason}\n\n${completed.summary}` : reason };
    content = updates.summary ?? reason;
  }
  const event: AgentEvent = { id: uuid(), taskId: completed.id, type: status === 'failed' ? 'error' : 'output', content, timestamp: now };
  await tasks.insertEvent(event);
  const { broadcast } = await import('../websocket.js');
  broadcast({ type: 'agent_event', payload: event });
  return await tasks.update(completed.id, updates) ?? completed;
}

export function createWorkersRouter(tasks: TaskRepository, workers: WorkerRepository, enrollmentCodes?: EnrollmentCodeRepository, projects?: ProjectRepository): Router {
  const router = Router();
  const workerEventTimestamps = new Map<string, { startedAt: number; count: number }>();
  const taskId = (req: Request): string => {
    const parameter = req.params.taskId;
    return typeof parameter === 'string' ? parameter : parameter[0];
  };
  const workerId = (req: Request): string => {
    const parameter = req.params.id;
    return typeof parameter === 'string' ? parameter : parameter[0];
  };
  const revokeAssignments = async (id: string, at: number): Promise<void> => {
    const released = await tasks.revokeWorkerAssignments(id, at);
    for (const task of released) {
      broadcastTaskUpdate(task);
    }
  };

  router.post('/enrollment-codes', asyncHandler(async (req: Request, res: Response) => {
    const ownerId = res.locals.principal?.id;
    if (!ownerId || !enrollmentCodes) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const projectId = req.body.projectId;
    if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim())) {
      res.status(400).json({ error: 'projectId must be a non-empty string when provided' });
      return;
    }
    const now = Date.now();
    const credentials = tokenHash();
    const expiresAt = now + ENROLLMENT_CODE_TTL_MS;
    await enrollmentCodes.create({
      codeHash: credentials.hash,
      ownerId,
      ...(typeof projectId === 'string' ? { projectId: projectId.trim() } : {}),
      expiresAt,
      createdAt: now,
    });
    res.status(201).json({ code: credentials.raw, expiresAt });
  }));

  router.post('/register', asyncHandler(async (req: Request, res: Response) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const agentTypes = req.body.agentTypes;
    const maxConcurrentTasks = req.body.maxConcurrentTasks ?? 1;
    const acceptedProjectIds = consentValues(req.body.acceptedProjectIds);
    const acceptedLabels = consentValues(req.body.acceptedLabels);
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
    if (!acceptedProjectIds || !acceptedLabels) {
      res.status(400).json({ error: 'acceptedProjectIds and acceptedLabels must be arrays of non-empty strings' });
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

    const enrollmentCode = typeof req.body.enrollmentCode === 'string' ? req.body.enrollmentCode.trim() : '';
    const enrollment = enrollmentCode && enrollmentCodes
      ? await enrollmentCodes.consume(crypto.createHash('sha256').update(enrollmentCode).digest('hex'), Date.now())
      : undefined;
    if (enrollmentCode && !enrollment) {
      res.status(401).json({ error: 'invalid or expired enrollment code' });
      return;
    }
    const now = Date.now();
    const credentials = tokenHash();
    const ownerId = enrollment?.ownerId ?? res.locals.principal?.id;
    const registration: WorkerRegistration = {
      id: uuid(),
      name,
      tokenHash: credentials.hash,
      agentTypes: agentTypes as AgentType[],
      maxConcurrentTasks,
      acceptedProjectIds,
      acceptedLabels,
      registeredAt: now,
      ...(ownerId ? { ownerId } : {}),
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

  router.patch('/:id/status', asyncHandler(async (req: Request, res: Response) => {
    const status = req.body.status;
    if (status !== 'online' && status !== 'disabled') {
      res.status(400).json({ error: 'status must be online or disabled' });
      return;
    }
    const now = Date.now();
    const id = workerId(req);
    const updated = await workers.setStatus(id, status, now);
    if (!updated) {
      res.status(404).json({ error: 'worker not found' });
      return;
    }
    if (status === 'disabled') await revokeAssignments(id, now);
    broadcastWorkerUpdate(updated);
    res.json(publicWorker(updated));
  }));

  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = workerId(req);
    const now = Date.now();
    const disabled = await workers.setStatus(id, 'disabled', now);
    if (!disabled) {
      res.status(404).json({ error: 'worker not found' });
      return;
    }
    await revokeAssignments(id, now);
    if (!await workers.delete(id)) {
      throw new Error(`worker ${id} disappeared during deletion`);
    }
    broadcastWorkerRemove(id);
    res.status(204).end();
  }));

  router.use('/me', workerAuth(workers));

  router.post('/me/rotate', asyncHandler(async (_req: Request, res: Response) => {
    const worker = authenticatedWorker(res);
    const now = Date.now();
    const credentials = tokenHash();
    const updated = await workers.rotateToken(worker.id, worker.tokenHash, credentials.hash, now);
    if (!updated) {
      res.status(409).json({ error: 'worker token was rotated concurrently' });
      return;
    }
    broadcastWorkerUpdate(updated);
    res.json({ worker: publicWorker(updated), token: credentials.raw });
  }));

  router.post('/me/heartbeat', asyncHandler(async (req: Request, res: Response) => {
    const worker = authenticatedWorker(res);
    const now = Date.now();
    const currentTaskId = req.body.currentTaskId;
    const acceptedProjectIds = consentValues(req.body.acceptedProjectIds);
    const acceptedLabels = consentValues(req.body.acceptedLabels);
    if (currentTaskId !== undefined && typeof currentTaskId !== 'string') {
      res.status(400).json({ error: 'currentTaskId must be a string' });
      return;
    }
    if ((req.body.acceptedProjectIds !== undefined && !acceptedProjectIds) || (req.body.acceptedLabels !== undefined && !acceptedLabels)) {
      res.status(400).json({ error: 'acceptedProjectIds and acceptedLabels must be arrays of non-empty strings' });
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
    const updated = await workers.heartbeat(worker.id, now, acceptedProjectIds, acceptedLabels);
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
    const assignments = await tasks.getWorkerAssignments(worker.id, Date.now());
    res.json({ tasks: await Promise.all(assignments.map(async (task) => toWorkerTaskAssignment(task, await projects?.getById(task.projectId)))) });
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
    res.json({ task: toWorkerTaskAssignment(claimed, await projects?.getById(claimed.projectId)), leaseExpiresAt: now + WORKER_TASK_LEASE_MS, claimToken: claim.raw });
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
    if (workerEventRateLimited(workerEventTimestamps, worker.id)) {
      res.status(429).json({ error: 'worker event rate limit exceeded' });
      return;
    }
    const submittedEvent = req.body as AgentEvent;
    if (
      submittedEvent.taskId !== task.id
      || !VALID_AGENT_EVENT_TYPES.has(submittedEvent.type)
      || typeof submittedEvent.content !== 'string'
      || submittedEvent.content.length > MAX_DESCRIPTION_LENGTH
      || !Number.isFinite(submittedEvent.timestamp)
      || !validWorkerEventMetadata(submittedEvent.metadata)
      || (submittedEvent.type === 'request_work' && !submittedEvent.metadata?.workRequest)
    ) {
      res.status(400).json({ error: 'invalid agent event' });
      return;
    }
    const event: AgentEvent = { ...submittedEvent, id: uuid() };
    if (submittedEvent.type === 'request_work') {
      const accepted = await withWorkRequestLock(`pending-work-requests:${task.id}`, async () => {
        if (await countPendingWorkRequests(tasks, task) >= MAX_PENDING_WORK_REQUESTS) return false;
        await tasks.insertEvent(event);
        return true;
      });
      if (!accepted) {
        console.warn(`[workers] rejected work request for task ${task.id} from worker ${worker.id}: ${MAX_PENDING_WORK_REQUESTS} requests already pending`);
        res.status(409).json({ error: `too many pending work requests (max ${MAX_PENDING_WORK_REQUESTS}); approve or dismiss existing requests first` });
        return;
      }
    } else {
      await tasks.insertEvent(event);
    }
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
    if (sessionId.length > MAX_DESCRIPTION_LENGTH) {
      res.status(400).json({ error: `sessionId must be at most ${MAX_DESCRIPTION_LENGTH} characters` });
      return;
    }
    const reviewVerdict = req.body.reviewVerdict;
    if (reviewVerdict !== undefined && reviewVerdict !== 'pass' && reviewVerdict !== 'changes_requested') {
      res.status(400).json({ error: 'reviewVerdict must be pass or changes_requested' });
      return;
    }
    const claim = claimTokenHash(req);
    if (!claim) {
      res.status(409).json({ error: 'task claim is invalid' });
      return;
    }
    const now = Date.now();

    // Mirror the in-process lifecycle (makeStatusCallback): finished work goes
    // to Review, a blocking question parks the task in Pending, and a failure
    // never leaves it stranded in Pending.
    if (status === 'awaiting_input') {
      const clarificationRequest = {
        requestId: uuid(),
        // The board requires a session id to accept an answer; runners that
        // cannot expose one resume with carried-over context instead.
        sessionId: sessionId || `worker-task:${task.id}`,
        prompt: question,
        timestamp: now,
      };
      // Single atomic write: agent_status, column_id, and clarification_request
      // land together, so a mid-write failure can never strand the row in
      // awaiting_clarification with no clarification_request (see BLOCKER 1
      // in the review: that state is invisible to every recovery predicate
      // and un-answerable via /clarification/resume).
      const parked = await tasks.parkWorkerTaskForClarification(task.id, worker.id, claim, now, clarificationRequest);
      if (!parked) {
        res.status(409).json({ error: 'task claim is expired or invalid' });
        return;
      }
      await workers.clearTaskSessions(task.id);
      await workers.clearTaskCommands(task.id);
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
      broadcastTaskUpdate(parked);
      res.json({ task: toWorkerTaskAssignment(parked) });
      return;
    }

    const completed = await tasks.completeWorkerTask(
      task.id,
      worker.id,
      claim,
      status,
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
    // A run's mode (review vs. implementation) is decided at assignment/claim
    // time from the task's columnId then, but re-deriving it here from the
    // task's CURRENT columnId is not stable: the card can move columns via an
    // unrelated request while the run is in flight. A worker only ever
    // includes reviewVerdict when it actually ran in review mode (mirroring
    // the columnId it was handed at claim time), so its presence — not the
    // possibly-drifted live columnId — is the authoritative signal that this
    // completion is a review settlement.
    const settled = reviewVerdict !== undefined
      ? await settleReviewRun(tasks, completed, req.body.status, reviewVerdict)
      : completed;
    broadcastTaskUpdate(settled);
    res.json({ task: toWorkerTaskAssignment(settled) });
  }));

  router.get('/usage', asyncHandler(async (_req: Request, res: Response) => {
    const visibleWorkers = res.locals.principal?.kind === 'service'
      ? (await workers.list()).filter((worker) => worker.ownerId === res.locals.principal.id)
      : await workers.list();
    const visibleById = new Map(visibleWorkers.map((worker) => [worker.id, worker]));
    const usageByWorker = new Map<string, UsageWorker>();

    for (const task of await tasks.getAll()) {
      const workerId = task.assignedWorkerId;
      if (!workerId) continue;
      const worker = visibleById.get(workerId);
      if (!worker) continue;
      for (const event of await tasks.getEventsByTaskId(task.id)) {
        const eventUsage = usageFromEvent(event);
        if (!eventUsage) continue;
        let workerUsage = usageByWorker.get(workerId);
        if (!workerUsage) {
          workerUsage = { workerId, workerName: worker.name, totals: emptyUsageTotals(), projects: [] };
          usageByWorker.set(workerId, workerUsage);
        }
        let projectUsage = workerUsage.projects.find((project) => project.projectId === task.projectId);
        if (!projectUsage) {
          projectUsage = { projectId: task.projectId, totals: emptyUsageTotals(), tasks: [] };
          workerUsage.projects.push(projectUsage);
        }
        let taskUsage = projectUsage.tasks.find((item) => item.taskId === task.id);
        if (!taskUsage) {
          taskUsage = { taskId: task.id, totals: emptyUsageTotals() };
          projectUsage.tasks.push(taskUsage);
        }
        addUsageTotals(workerUsage.totals, eventUsage);
        addUsageTotals(projectUsage.totals, eventUsage);
        addUsageTotals(taskUsage.totals, eventUsage);
      }
    }

    const workersUsage = [...usageByWorker.values()];
    const totals = emptyUsageTotals();
    for (const workerUsage of workersUsage) addUsageTotals(totals, workerUsage.totals);
    res.json({ totals, workers: workersUsage });
  }));

  router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    const visibleWorkers = res.locals.principal?.kind === 'service'
      ? (await workers.list()).filter((worker) => worker.ownerId === res.locals.principal.id)
      : await workers.list();
    res.json(visibleWorkers.map(publicWorker));
  }));

  return router;
}
