import type { Task, TaskGroup } from './types.js';
import type { ProjectRepository } from './repositories/project-types.js';
import type { TaskRepository } from './repositories/types.js';
import type { TaskGroupRepository } from './repositories/group-types.js';

export function shouldRecoverGroupChildAsFailed(status: Task['agentStatus']): boolean {
  return status === 'executing';
}

export function shouldRecoverGroupChildToIdle(status: Task['agentStatus']): boolean {
  return status === 'planning';
}

export function shouldRecoverStandaloneTaskAsFailed(status: Task['agentStatus']): boolean {
  return status === 'planning' || status === 'executing';
}

/**
 * Startup recovery must inspect every project, not just the default one:
 * `TaskRepository.getAll` and `TaskGroupRepository.getAll` both default their
 * `projectId` parameter to `'default'`, so a caller that omits it silently
 * scopes the scan to a single project and misses orphaned work elsewhere.
 */
export async function getAllTasksAcrossProjects(
  projectRepo: Pick<ProjectRepository, 'getAllWithCounts'>,
  taskRepo: Pick<TaskRepository, 'getAll'>,
): Promise<Task[]> {
  const projects = await projectRepo.getAllWithCounts();
  const perProject = await Promise.all(projects.map((project) => taskRepo.getAll(false, project.id)));
  return perProject.flat();
}

export async function getAllGroupsAcrossProjects(
  projectRepo: Pick<ProjectRepository, 'getAllWithCounts'>,
  groupRepo: Pick<TaskGroupRepository, 'getAll'>,
): Promise<TaskGroup[]> {
  const projects = await projectRepo.getAllWithCounts();
  const perProject = await Promise.all(projects.map((project) => groupRepo.getAll(false, project.id)));
  return perProject.flat();
}
