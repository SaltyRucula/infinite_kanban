import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Task } from '../types.js';
import { isValidAgentType, VALID_AGENT_TYPES } from '@ai-agent-board/shared/constants.js';
import type { TaskRepository } from '../repositories/types.js';
import type { TaskGroupRepository } from '../repositories/group-types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { WorkerRepository } from '../repositories/worker-types.js';
import { broadcast } from '../websocket.js';
import type { AgentManager } from '../services/agent-manager.js';
import { buildOpenCodeSessionUrl } from '../opencode/session-link.js';
import { resolveTaskOpenCodeSession } from '../opencode/session-resolver.js';
import {
  asyncHandler, paramId, isValidGitRef,
  broadcastTaskUpdate, broadcastGroupUpdate, makeRetryAwareStatusHandler, makeWorktreeCallback, isRateLimited,
  rejectTaskPathFields, toPortableTask,
} from './helpers.js';

export function createAgentRouter(
  repo: TaskRepository,
  agentManager: AgentManager,
  groupRepo?: TaskGroupRepository,
  projectRepo?: ProjectRepository,
  workerRepo?: WorkerRepository,
): Router {
  const router = Router();

  const hasActiveWorkerLease = (task: Task): boolean => {
    return task.assignedWorkerId != null
      && (task.agentStatus === 'planning' || task.agentStatus === 'executing' || task.agentStatus === 'awaiting_clarification');
  };

  const hasLiveOpenCodeSession = (task: Task): boolean => {
    return task.workerLeaseExpiresAt != null && task.workerLeaseExpiresAt >= Date.now();
  };

  const hasMatchingWorkerSession = async (workerSessions: WorkerRepository, task: Task): Promise<boolean> => {
    const sessionId = agentManager.getSessionIdentity(task.id);
    if (!sessionId) return false;
    const sessions = await workerSessions.getTaskSessions(task.id);
    return sessions.some((session) => session.sessionId === sessionId);
  };

  const enqueueWorkerCommand = async (
    task: Task,
    command:
      | { readonly type: 'cancel' }
      | { readonly type: 'message'; readonly message: string; readonly attachmentIds?: readonly string[] }
      | { readonly type: 'clarification'; readonly requestId: string; readonly sessionId: string; readonly answer: string },
  ): Promise<boolean> => {
    if (!workerRepo || !task.assignedWorkerId || !hasActiveWorkerLease(task)) return false;
    if (command.type === 'cancel') {
      await workerRepo.enqueueTaskCommand(task.id, {
        id: uuid(),
        type: 'cancel',
        createdAt: Date.now(),
      });
      return true;
    }
    if (command.type === 'message') {
      await workerRepo.enqueueTaskCommand(task.id, {
        id: uuid(),
        type: 'message',
        message: command.message,
        createdAt: Date.now(),
        ...(command.attachmentIds && command.attachmentIds.length > 0 ? { attachmentIds: command.attachmentIds } : {}),
      });
      return true;
    }
    await workerRepo.enqueueTaskCommand(task.id, {
      id: uuid(),
      type: 'clarification',
      createdAt: Date.now(),
      requestId: command.requestId,
      sessionId: command.sessionId,
      answer: command.answer,
    });
    return true;
  };

  // POST /api/tasks/:id/configure — store worktree config before running
  router.post('/:id/configure', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    const pathError = rejectTaskPathFields(req.body);
    if (pathError) { res.status(400).json({ error: pathError }); return; }

    const { branchName, baseBranch, useWorktree, agentType } = req.body;
    const project = projectRepo ? await projectRepo.getById(task.projectId ?? 'default') : undefined;
    if (req.body.projectId !== undefined && req.body.projectId !== (task.projectId ?? 'default')) {
      res.status(400).json({ error: 'projectId is immutable' });
      return;
    }
    if (projectRepo && !project) {
      res.status(400).json({ error: 'task project not found' });
      return;
    }

    if (branchName !== undefined && typeof branchName !== 'string') {
      res.status(400).json({ error: 'branchName must be a string' });
      return;
    }
    if (baseBranch !== undefined && typeof baseBranch !== 'string') {
      res.status(400).json({ error: 'baseBranch must be a string' });
      return;
    }
    if (useWorktree !== undefined && typeof useWorktree !== 'boolean') {
      res.status(400).json({ error: 'useWorktree must be a boolean' });
      return;
    }
    if (agentType !== undefined && !isValidAgentType(agentType)) {
      res.status(400).json({ error: `invalid agentType: must be one of ${VALID_AGENT_TYPES.join(', ')}` });
      return;
    }
    if (typeof branchName === 'string' && branchName !== '' && !isValidGitRef(branchName)) {
      res.status(400).json({ error: 'branchName contains invalid characters' });
      return;
    }
    if (typeof baseBranch === 'string' && !isValidGitRef(baseBranch)) {
      res.status(400).json({ error: 'baseBranch contains invalid characters' });
      return;
    }
    const updates: Partial<Task> = {};
    if (branchName !== undefined) updates.branchName = branchName || undefined;
    if (baseBranch !== undefined) updates.baseBranch = baseBranch;
    if (useWorktree !== undefined) updates.useWorktree = useWorktree;
    if (agentType !== undefined) updates.agentType = agentType;

    const updated = await repo.update(id, updates);
    if (!updated) {
      res.status(500).json({ error: 'failed to update task' });
      return;
    }
    broadcastTaskUpdate(updated);
    res.json(toPortableTask(updated));
  }));

  // POST /api/tasks/:id/run
  router.post('/:id/run', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    if (isRateLimited(id)) {
      res.status(429).json({ error: 'too many requests, try again shortly' });
      return;
    }
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (!task.assignedWorkerId) {
      res.status(409).json({ error: 'worker assignment is required' });
      return;
    }
    if (agentManager.isRunning(task.id)) {
      res.status(409).json({ error: 'agent already running for this task' });
      return;
    }

    // Persist intent before claiming; a crash between these operations is recovered at startup.
    agentManager.resetEvents(task.id);
    await repo.requestRun(task.id, Date.now());

    const updates: Partial<Task> = {
      agentStatus: 'planning',
      startedAt: Date.now(),
      completedAt: undefined,
    };
    if (task.columnId === 'backlog') {
      updates.columnId = 'in-progress';
    }
    const updated = await repo.update(task.id, updates);
    if (!updated) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    broadcastTaskUpdate(updated);

    // E8: If this task belongs to a group in 'review', move group back to in-progress
    if (updated.groupId && groupRepo) {
      const group = await groupRepo.getById(updated.groupId);
      if (group && group.columnId === 'review') {
        const movedGroup = await groupRepo.update(group.id, {
          columnId: 'in-progress',
          completedAt: undefined,
        });
        if (movedGroup) broadcastGroupUpdate(movedGroup);
      }
    }

    // Worker-assigned tasks are executed by their remote worker, which claims
    // this task itself via GET /me/assignments + POST /me/tasks/:id/claim now
    // that run_requested_at is set (see requestRun above). Starting it here
    // too would run it in-process on THIS server, whose AgentManager may not
    // even have the agent's CLI installed — that's the whole reason workers
    // exist — so only start locally when no worker is assigned.
    if (!updated.assignedWorkerId) {
      agentManager.startAgent(
        updated,
        makeRetryAwareStatusHandler(repo, agentManager, updated),
        makeWorktreeCallback(repo, task.id),
      );
    }

    res.json(toPortableTask(updated));
  }));

  // POST /api/tasks/:id/stop
  router.post('/:id/stop', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    if (isRateLimited(id)) {
      res.status(429).json({ error: 'too many requests, try again shortly' });
      return;
    }
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (await enqueueWorkerCommand(task, { type: 'cancel' })) {
      const updated = await repo.update(task.id, { agentStatus: 'failed' });
      if (!updated) {
        res.status(404).json({ error: 'task not found' });
        return;
      }
      await workerRepo?.clearTaskSessions(task.id);
      broadcastTaskUpdate(updated);
      res.json(toPortableTask(updated));
      return;
    }
    const stopped = await agentManager.stopAgent(task.id);
    if (!stopped) {
      res.status(409).json({ error: 'no running agent for this task' });
      return;
    }
    const updated = await repo.update(task.id, { agentStatus: 'failed' });
    if (!updated) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    broadcastTaskUpdate(updated);
    res.json(toPortableTask(updated));
  }));

  // POST /api/tasks/:id/message — send a follow-up message to a running agent
  router.post('/:id/message', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    const { message, attachmentIds } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required and must be a non-empty string' });
      return;
    }

    if (task.agentStatus === 'awaiting_clarification') {
      res.status(409).json({ error: 'task is awaiting clarification; use /clarification/resume with requestId and sessionId' });
      return;
    }

    const validIds = Array.isArray(attachmentIds) ? attachmentIds.filter((id: unknown) => typeof id === 'string') : undefined;
    if (await enqueueWorkerCommand(task, { type: 'message', message: message.trim(), attachmentIds: validIds })) {
      broadcast({ type: 'agent_follow_up', payload: { taskId: task.id, message: message.trim(), attachmentIds: validIds } });
      res.json({ success: true });
      return;
    }

    if (!agentManager.isRunning(task.id)) {
      res.status(409).json({ error: 'no running agent for this task' });
      return;
    }

    try {
      await agentManager.sendMessage(task.id, message, validIds);
      broadcast({ type: 'agent_follow_up', payload: { taskId: task.id, message, attachmentIds: validIds } });
      res.json({ success: true });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'failed to send message' });
    }
  }));

  router.post('/:id/clarification/resume', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    if (task.agentStatus !== 'awaiting_clarification') {
      res.status(409).json({
        error: 'task is not awaiting clarification; clarification responses are only accepted while agentStatus is awaiting_clarification',
        code: 'clarification_not_pending',
      });
      return;
    }

    const requestId = typeof req.body.requestId === 'string' ? req.body.requestId : '';
    const sessionId = typeof req.body.sessionId === 'string' ? req.body.sessionId : '';
    const answer = typeof req.body.answer === 'string' ? req.body.answer : '';

    if (await enqueueWorkerCommand(task, {
      type: 'clarification',
      requestId,
      sessionId,
      answer,
    })) {
      res.json({ success: true, code: 'queued_for_worker', message: 'clarification queued for worker session' });
      return;
    }

    const result = await agentManager.resumeClarification(task.id, {
      requestId,
      sessionId,
      answer,
    });

    if (result.ok) {
      res.json({ success: true, code: result.code, message: result.message });
      return;
    }

    if (result.code === 'invalid_request') {
      res.status(400).json({ error: result.message, code: result.code });
      return;
    }

    res.status(409).json({ error: result.message, code: result.code });
  }));

  // GET /api/tasks/:id/events?since=<timestamp>&limit=<n>
  router.get('/:id/events', asyncHandler(async (req: Request, res: Response) => {
    if (!await repo.getById(paramId(req))) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    let events = await agentManager.getEvents(paramId(req));
    const since = Number(req.query.since);
    if (since > 0) {
      events = events.filter(e => e.timestamp > since);
    }
    const limit = Number(req.query.limit);
    if (limit > 0) {
      events = events.slice(-limit);
    }
    res.json(events);
  }));

  // GET /api/tasks/:id/opencode-session — deep link to the live OpenCode session
  router.get('/:id/opencode-session', asyncHandler(async (req: Request, res: Response) => {
    const task = await repo.getById(paramId(req));
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (task.agentType !== 'opencode') {
      res.status(409).json({ error: 'task is not an OpenCode-backed task' });
      return;
    }
    if (!workerRepo) {
      res.status(503).json({ error: 'worker repository is not configured' });
      return;
    }
    const workerSessions = workerRepo;
    if (!hasActiveWorkerLease(task) || !hasLiveOpenCodeSession(task) || !await hasMatchingWorkerSession(workerSessions, task)) {
      res.status(404).json({ error: 'no OpenCode session found for this task' });
      return;
    }
    const resolved = resolveTaskOpenCodeSession(await workerSessions.getTaskSessions(task.id), agentManager.getSessionIdentity(task.id));
    if (!resolved) {
      res.status(404).json({ error: 'no OpenCode session found for this task' });
      return;
    }
    res.json({
      sessionId: resolved.sessionId,
      url: buildOpenCodeSessionUrl(resolved.baseUrl, resolved.sessionId),
    });
  }));

  return router;
}
