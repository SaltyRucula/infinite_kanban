import type { RequestHandler } from 'express';
import type { BoardWorkflowCoordinator } from '../services/board-workflow.js';
import type { TaskRepository } from '../repositories/types.js';
import type { TaskGroupRepository } from '../repositories/group-types.js';

interface OwnershipResources {
  tasks: Pick<TaskRepository, 'getAll'>;
  groups: Pick<TaskGroupRepository, 'getChildTasks'>;
}

/** Protect legacy writes, including indirect group/project cascade mutations. */
export function createWorkflowOwnershipGuard(
  workflow: Pick<BoardWorkflowCoordinator, 'ownsTask'>,
  resources: OwnershipResources,
): RequestHandler {
  return async (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
    try {
      const taskId = req.path.match(/^\/tasks\/([^/]+)/)?.[1];
      const groupId = req.path.match(/^\/groups\/([^/]+)/)?.[1];
      const projectId = req.method === 'DELETE' ? req.path.match(/^\/projects\/([^/]+)\/?$/)?.[1] : undefined;
      const taskIds: string[] = taskId ? [decodeURIComponent(taskId)] : [];
      if (groupId) taskIds.push(...(await resources.groups.getChildTasks(decodeURIComponent(groupId))).map((task) => task.id));
      if (projectId) taskIds.push(...(await resources.tasks.getAll(true, decodeURIComponent(projectId))).map((task) => task.id));
      for (const id of taskIds) {
        if (await workflow.ownsTask(id)) {
          res.status(409).json({ error: 'task is owned by its workflow; use workflow approval/cancel' });
          return;
        }
      }
      next();
    } catch (error) { next(error); }
  };
}
