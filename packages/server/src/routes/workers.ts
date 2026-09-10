import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { v4 as uuid } from 'uuid';
import {
  isValidAgentType,
  isValidMaxConcurrency,
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
import { asyncHandler, broadcastTaskUpdate } from './helpers.js';

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
    res.json({ worker: publicWorker(updated) });
  }));

  router.get('/me/assignments', asyncHandler(async (_req: Request, res: Response) => {
    const worker = authenticatedWorker(res);
    res.json({ tasks: await tasks.getWorkerAssignments(worker.id, Date.now()) });
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
    res.json({ task: claimed, leaseExpiresAt: now + WORKER_TASK_LEASE_MS, claimToken: claim.raw });
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
    if (req.body.status !== 'complete' && req.body.status !== 'failed') {
      res.status(400).json({ error: 'status must be complete or failed' });
      return;
    }
    const claim = claimTokenHash(req);
    if (!claim) {
      res.status(409).json({ error: 'task claim is invalid' });
      return;
    }
    const completed = await tasks.completeWorkerTask(
      task.id,
      worker.id,
      claim,
      req.body.status,
      Date.now(),
      typeof req.body.summary === 'string' ? req.body.summary : undefined,
      typeof req.body.error === 'string' ? req.body.error : undefined,
    );
    if (!completed) {
      res.status(409).json({ error: 'task claim is expired or invalid' });
      return;
    }
    broadcastTaskUpdate(completed);
    res.json({ task: completed });
  }));

  router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    res.json((await workers.list()).map(publicWorker));
  }));

  return router;
}
