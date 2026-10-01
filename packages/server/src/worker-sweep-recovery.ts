import type { Task } from './types.js';
import type { TaskRepository } from './repositories/types.js';
import type { WorkerRepository } from './repositories/worker-types.js';

/**
 * Fails a worker task abandoned by an offline worker or an expired lease.
 * Clearing the durable request prevents a later column drag from silently
 * handing the failed task back to a worker without an explicit Run action.
 */
export async function failStrandedWorkerTask(
  task: Task,
  now: number,
  taskRepo: Pick<TaskRepository, 'update'>,
  workerRepo: Pick<WorkerRepository, 'clearTaskSessions' | 'clearTaskCommands'>,
  broadcastTaskUpdate: (task: Task) => void,
): Promise<void> {
  const updates: Partial<Task> = {
    agentStatus: 'failed',
    completedAt: now,
    summary: 'worker_offline',
    runRequestedAt: undefined,
    runClaimedAt: undefined,
    clarificationRequest: null,
    clarificationAnswer: null,
  };
  if (task.columnId === 'pending') updates.columnId = 'in-progress';

  const failed = await taskRepo.update(task.id, updates);
  if (!failed) return;

  await workerRepo.clearTaskSessions(task.id);
  await workerRepo.clearTaskCommands(task.id);
  broadcastTaskUpdate(failed);
}
