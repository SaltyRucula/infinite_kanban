import type { Task, TaskGroup } from './types.js';
import type { ProjectRepository } from './repositories/project-types.js';
import type { TaskRepository } from './repositories/types.js';
import type { TaskGroupRepository } from './repositories/group-types.js';
import type { WorkerRepository } from './repositories/worker-types.js';

export function shouldRecoverGroupChildAsFailed(status: Task['agentStatus']): boolean {
  return status === 'executing';
}

export function shouldRecoverGroupChildToIdle(status: Task['agentStatus']): boolean {
  return status === 'planning';
}

export function shouldRecoverStandaloneTaskAsFailed(status: Task['agentStatus'], hasClarificationRequest = true): boolean {
  if (status === 'planning' || status === 'executing') return true;
  // Defense in depth: a park write that fails partway through (see BLOCKER 1
  // in the review — completeWorkerTask + a second tasks.update writing
  // clarification_request used to be two non-atomic writes) can leave a row
  // stuck in awaiting_clarification with no clarification_request. That state
  // is invisible to getWorkerAssignments/getExpiredWorkerTasks/
  // getAssignedWorkerTasks/getPendingRuns and un-answerable via
  // /clarification/resume, so treat it as failed/recoverable too.
  if (status === 'awaiting_clarification' && !hasClarificationRequest) return true;
  return false;
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

export interface RecoverOrphanedStandaloneTasksDependencies {
  readonly taskRepo: Pick<TaskRepository, 'update' | 'clearRun'>;
  readonly workerRepo: Pick<WorkerRepository, 'clearTaskSessions'>;
  readonly onRecovered?: (task: Task) => void;
}

/**
 * Recover standalone tasks (not group children, not already re-dispatched
 * this startup) orphaned by a previous server restart: mark them failed and
 * clear run/session/clarification state so they can be re-run cleanly.
 *
 * Clearing clarificationRequest/clarificationAnswer here matters: a resumed
 * run (agentStatus planning/executing with a carried-over Q&A) that crashed
 * mid-flight still has both set — only a clean completion clears them
 * (see completeWorkerTask/makeStatusCallback) — so leaving them here would
 * let workerResume() inject that stale Q&A into the next, unrelated run.
 */
export async function recoverOrphanedStandaloneTasks(
  tasks: readonly Task[],
  excludeIds: ReadonlySet<string>,
  deps: RecoverOrphanedStandaloneTasksDependencies,
): Promise<readonly Task[]> {
  const orphaned = tasks.filter((t) => shouldRecoverStandaloneTaskAsFailed(t.agentStatus, !!t.clarificationRequest) && !excludeIds.has(t.id));
  for (const task of orphaned) {
    await deps.taskRepo.update(task.id, {
      agentStatus: 'failed',
      completedAt: Date.now(),
      clarificationRequest: null,
      clarificationAnswer: null,
    });
    await deps.taskRepo.clearRun(task.id);
    await deps.workerRepo.clearTaskSessions(task.id);
    deps.onRecovered?.(task);
  }
  return orphaned;
}
