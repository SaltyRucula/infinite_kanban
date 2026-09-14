import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { Project, TaskGroup } from '../types.js';
import {
  isValidPriority,
  isValidAgentType,
  isValidColumnId,
  isValidMaxConcurrency,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_GROUP_CHILDREN,
  MIN_GROUP_CHILDREN,
} from '@ai-agent-board/shared/constants.js';
import type { TaskGroupRepository } from '../repositories/group-types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { AgentManager } from '../services/agent-manager.js';
import {
  asyncHandler,
  paramId,
  isValidGitRef,
  broadcastGroupUpdate,
  broadcastTaskUpdate,
  isRateLimited,
  rejectGroupPathFields,
  toPortableTask,
  toPortableTaskGroup,
} from './helpers.js';

export function createGroupsRouter(
  groupRepo: TaskGroupRepository,
  taskRepo: TaskRepository,
  agentManager: AgentManager,
  projectRepo: ProjectRepository,
): Router {
  const router = Router();

  // GET /api/groups — list all groups
  router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    const includeArchived = _req.query.archived === 'true';
    const project = await getProjectForRequest(projectRepo, _req.query.projectId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const groups = await groupRepo.getAll(includeArchived, project.id);
    // Attach child task summaries
    const result = await Promise.all(
      groups.map(async (g) => {
        const children = await groupRepo.getChildTasks(g.id);
        return { ...toPortableTaskGroup(g), children: children.map(toPortableTask) };
      }),
    );
    res.json(result);
  }));

  // GET /api/groups/:id — get group with children
  router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const group = await groupRepo.getById(id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    const children = await groupRepo.getChildTasks(id);
    res.json({ ...toPortableTaskGroup(group), children: children.map(toPortableTask) });
  }));

  // POST /api/groups — create group with children
  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const project = await getProjectForRequest(projectRepo, req.body.projectId);
    if (!project) { res.status(400).json({ error: 'projectId is invalid' }); return; }
    const pathError = rejectGroupPathFields(req.body);
    if (pathError) { res.status(400).json({ error: pathError }); return; }
    const { title, description, priority, baseBranch, maxConcurrency, children, autoRun } = req.body;

    // Validate group fields
    if (!title || typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: 'title is required' }); return;
    }
    if (title.length > MAX_TITLE_LENGTH) {
      res.status(400).json({ error: `title must be at most ${MAX_TITLE_LENGTH} characters` }); return;
    }
    if (description !== undefined && typeof description !== 'string') {
      res.status(400).json({ error: 'description must be a string' }); return;
    }
    if (typeof description === 'string' && description.length > MAX_DESCRIPTION_LENGTH) {
      res.status(400).json({ error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters` }); return;
    }
    if (priority !== undefined && !isValidPriority(priority)) {
      res.status(400).json({ error: 'invalid priority' }); return;
    }

    if (baseBranch !== undefined && typeof baseBranch === 'string' && !isValidGitRef(baseBranch)) {
      res.status(400).json({ error: 'baseBranch contains invalid characters' }); return;
    }

    // Validate children
    if (!Array.isArray(children) || children.length < MIN_GROUP_CHILDREN) {
      res.status(400).json({ error: `children must be an array with at least ${MIN_GROUP_CHILDREN} items` }); return;
    }
    if (children.length > MAX_GROUP_CHILDREN) {
      res.status(400).json({ error: `children must have at most ${MAX_GROUP_CHILDREN} items` }); return;
    }

    // Validate concurrency
    const concurrency = typeof maxConcurrency === 'number' ? maxConcurrency : 2;
    if (!isValidMaxConcurrency(concurrency, children.length)) {
      res.status(400).json({ error: `maxConcurrency must be between 1 and ${children.length}` }); return;
    }

    // Validate each child
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child && typeof child === 'object') {
        const childPathError = rejectGroupPathFields(child);
        if (childPathError) { res.status(400).json({ error: `children[${i}]: ${childPathError}` }); return; }
      }
      if (!child.title || typeof child.title !== 'string' || !child.title.trim()) {
        res.status(400).json({ error: `children[${i}].title is required` }); return;
      }
      if (child.title.length > MAX_TITLE_LENGTH) {
        res.status(400).json({ error: `children[${i}].title exceeds max length` }); return;
      }
      if (child.description !== undefined && typeof child.description !== 'string') {
        res.status(400).json({ error: `children[${i}].description must be a string` }); return;
      }
      if (child.agentType !== undefined && !isValidAgentType(child.agentType)) {
        res.status(400).json({ error: `children[${i}].agentType is invalid` }); return;
      }
    }

    const now = Date.now();
    const groupId = uuid();

    // Project defaults fill fields the request left undefined (each overridable per group/child).
    const effectivePriority = priority !== undefined ? priority : (project.defaultPriority ?? 'medium');
    const effectiveBaseBranch = baseBranch !== undefined ? (baseBranch || undefined) : project.defaultBaseBranch;

    const group: TaskGroup = {
      id: groupId,
      projectId: project.id,
      title: title.trim(),
      description: description?.trim() || undefined,
      priority: effectivePriority,
      columnId: autoRun ? 'in-progress' : 'backlog',
      baseBranch: effectiveBaseBranch,
      maxConcurrency: concurrency,
      createdAt: now,
    };

    const childDefs = children.map((child: any, i: number) => {
      const useWorktree = child.useWorktree !== undefined
        ? child.useWorktree
        : (project.defaultUseWorktree ?? true);
      return {
        id: uuid(),
        projectId: project.id,
        title: child.title.trim(),
        description: child.description?.trim() || '',
        priority: child.priority || group.priority,
        agentType: child.agentType !== undefined ? child.agentType : (project.defaultAgentType ?? 'copilot'),
        useWorktree,
        branchName: useWorktree !== false
          ? `group/${groupId.slice(0, 8)}/${i}-${slugify(child.title)}`
          : undefined,
        groupId,
        groupOrder: i,
        labels: [],
      };
    });

    try {
      const result = await groupRepo.create(group, childDefs);
      broadcastGroupUpdate(result.group);

      // Auto-run if requested
      if (autoRun) {
        const updated = await groupRepo.update(groupId, { startedAt: now });
        if (updated) broadcastGroupUpdate(updated);
        const executionError = await startGroupExecution(groupId, groupRepo, taskRepo);
        if (executionError) {
          res.status(409).json({ error: executionError });
          return;
        }
      }

      const finalGroup = await groupRepo.getById(groupId);
      const finalChildren = await groupRepo.getChildTasks(groupId);
      res.status(201).json({ ...toPortableTaskGroup(finalGroup || result.group), children: finalChildren.map(toPortableTask) });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create group' });
    }
  }));

  // PATCH /api/groups/:id — update group metadata
  router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const group = await groupRepo.getById(id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }
    const groupProjectId = group.projectId ?? 'default';
    if (req.body.projectId !== undefined && req.body.projectId !== groupProjectId) {
      res.status(400).json({ error: 'projectId is immutable' }); return;
    }
    const pathError = rejectGroupPathFields(req.body);
    if (pathError) { res.status(400).json({ error: pathError }); return; }

    const updates: Partial<TaskGroup> = {};
    if (req.body.title !== undefined) {
      if (typeof req.body.title !== 'string' || !req.body.title.trim()) {
        res.status(400).json({ error: 'title must be a non-empty string' }); return;
      }
      if (req.body.title.length > MAX_TITLE_LENGTH) {
        res.status(400).json({ error: `title must be at most ${MAX_TITLE_LENGTH} characters` }); return;
      }
      updates.title = req.body.title;
    }
    if (req.body.description !== undefined) {
      if (typeof req.body.description !== 'string') {
        res.status(400).json({ error: 'description must be a string' }); return;
      }
      if (req.body.description.length > MAX_DESCRIPTION_LENGTH) {
        res.status(400).json({ error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters` }); return;
      }
      updates.description = req.body.description;
    }
    if (req.body.priority !== undefined) {
      if (!isValidPriority(req.body.priority)) { res.status(400).json({ error: 'invalid priority' }); return; }
      updates.priority = req.body.priority;
    }
    if (req.body.maxConcurrency !== undefined) {
      const children = await groupRepo.getChildTasks(id);
      const mc = req.body.maxConcurrency;
      if (!isValidMaxConcurrency(mc, children.length)) {
        res.status(400).json({ error: `maxConcurrency must be an integer between 1 and ${children.length}` }); return;
      }
      updates.maxConcurrency = mc;
    }
    if (req.body.columnId !== undefined) {
      if (!isValidColumnId(req.body.columnId)) {
        res.status(400).json({ error: 'invalid columnId' }); return;
      }
      if (req.body.columnId === 'pending') {
        res.status(400).json({ error: 'task groups cannot be moved to pending' }); return;
      }
      updates.columnId = req.body.columnId;
    }
    if (req.body.archived !== undefined) updates.archived = Boolean(req.body.archived);

    // E3: Moving group back to backlog stops all running children and resets state
    if (updates.columnId === 'backlog' && group.columnId !== 'backlog') {
      if (agentManager.isGroupRunning(id)) {
        await agentManager.stopGroup(id);
      }
      const children = await groupRepo.getChildTasks(id);
      for (const child of children) {
        // Clean up worktree if one was created
        if (child.worktreePath) {
          try { agentManager.removeWorktree(child); } catch { /* best effort */ }
        }
        if (child.agentStatus !== 'idle') {
          await taskRepo.update(child.id, {
            agentStatus: 'idle',
            startedAt: undefined,
            completedAt: undefined,
            worktreePath: undefined,
          });
        }
      }
      updates.startedAt = undefined;
      updates.completedAt = undefined;
    }

    const updated = await groupRepo.update(id, updates);
    if (updated) {
      broadcastGroupUpdate(updated);
      const children = await groupRepo.getChildTasks(id);
       res.json({ ...toPortableTaskGroup(updated), children: children.map(toPortableTask) });
    } else {
      res.status(500).json({ error: 'Failed to update group' });
    }
  }));

  // DELETE /api/groups/:id — delete group + cascade children + stop agents
  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const group = await groupRepo.getById(id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }

    // Stop group queue + all running agents
    await agentManager.stopGroup(id);

    // Clean up worktrees
    const children = await groupRepo.getChildTasks(id);
    for (const child of children) {
      if (child.worktreePath) {
        try { agentManager.removeWorktree(child); } catch { /* best effort */ }
      }
    }

    // CASCADE delete handles children
    await groupRepo.delete(id);
    res.status(204).send();
  }));

  // POST /api/groups/:id/run — start group execution
  router.post('/:id/run', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    if (isRateLimited(id)) {
      res.status(429).json({ error: 'Rate limited — wait a few seconds' }); return;
    }

    const group = await groupRepo.getById(id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }

    const pathError = rejectGroupPathFields(req.body);
    if (pathError) { res.status(400).json({ error: pathError }); return; }

    if (agentManager.isGroupRunning(id)) {
      res.status(409).json({ error: 'group is already running' }); return;
    }

    const executionError = await startGroupExecution(id, groupRepo, taskRepo);
    if (executionError) {
      res.status(409).json({ error: executionError });
      return;
    }

    const now = Date.now();
    const updated = await groupRepo.update(id, {
      columnId: 'in-progress',
      startedAt: now,
      completedAt: undefined,
    });
    if (updated) broadcastGroupUpdate(updated);

    const finalGroup = await groupRepo.getById(id);
    const children = await groupRepo.getChildTasks(id);
    res.json({ ...toPortableTaskGroup(finalGroup || updated || group), children: children.map(toPortableTask) });
  }));

  // POST /api/groups/:id/stop — stop all running children
  router.post('/:id/stop', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const group = await groupRepo.getById(id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }

    await agentManager.stopGroup(id);

    // Mark remaining pending children as idle
    const children = await groupRepo.getChildTasks(id);
    for (const child of children) {
      if (child.agentStatus === 'planning' || child.agentStatus === 'executing' || child.agentStatus === 'awaiting_clarification') {
        const t = await taskRepo.update(child.id, { agentStatus: 'failed' });
        if (t) broadcastTaskUpdate(t);
      }
    }

    const updated = await groupRepo.update(id, { completedAt: Date.now() });
    if (updated) broadcastGroupUpdate(updated);

    res.json({ stopped: true });
  }));

  // PATCH /api/groups/:id/archive — archive group + all children
  router.patch('/:id/archive', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const group = await groupRepo.getById(id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }

    // Stop running agents first
    if (agentManager.isGroupRunning(id)) {
      await agentManager.stopGroup(id);
    }

    // Archive all children and clean up worktrees
    const children = await groupRepo.getChildTasks(id);
    for (const child of children) {
      if (child.worktreePath) {
        try { agentManager.removeWorktree(child); } catch { /* best effort */ }
      }
      const t = await taskRepo.update(child.id, { archived: true, worktreePath: undefined });
      if (t) broadcastTaskUpdate(t);
    }

    const updated = await groupRepo.update(id, { archived: true });
    if (updated) broadcastGroupUpdate(updated);
    res.json(updated ? toPortableTaskGroup(updated) : updated);
  }));

  // PATCH /api/groups/:id/unarchive — restore group + children to backlog
  router.patch('/:id/unarchive', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const group = await groupRepo.getById(id);
    if (!group) { res.status(404).json({ error: 'group not found' }); return; }

    const children = await groupRepo.getChildTasks(id);
    for (const child of children) {
      const t = await taskRepo.update(child.id, { archived: false, agentStatus: 'idle', columnId: 'backlog' });
      if (t) broadcastTaskUpdate(t);
    }

    const updated = await groupRepo.update(id, { archived: false, columnId: 'backlog', startedAt: undefined, completedAt: undefined });
    if (updated) broadcastGroupUpdate(updated);
    res.json(updated ? toPortableTaskGroup(updated) : updated);
  }));

  return router;
}

// ─── Helpers ────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

async function startGroupExecution(
  groupId: string,
  groupRepo: TaskGroupRepository,
  taskRepo: TaskRepository,
): Promise<string | undefined> {
  const group = await groupRepo.getById(groupId);
  if (!group) return;

  const children = await groupRepo.getChildTasks(groupId);
  const pendingChildren = children.filter((c) => c.agentStatus === 'idle' || c.agentStatus === 'failed');

  if (pendingChildren.length === 0) return;
  if (pendingChildren.some((child) => !child.assignedWorkerId)) {
    return 'all group children must have worker assignments';
  }
  for (const child of pendingChildren) {
    await taskRepo.requestRun(child.id, Date.now());
  }
}

async function getProjectForRequest(projectRepo: ProjectRepository, value: unknown): Promise<Project | undefined> {
  if (typeof value === 'string' && value) return projectRepo.getById(value);
  return projectRepo.getDefault();
}
