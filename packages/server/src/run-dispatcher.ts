import type { Task } from './types.js';
import type { TaskRepository } from './repositories/types.js';

interface PendingRunDispatchOptions {
  readonly staleBefore?: number;
  readonly onDispatchingTask?: (task: Task) => void;
}

interface PendingRunDispatchDependencies {
  readonly taskRepo: Pick<TaskRepository, 'getPendingRuns'>;
  readonly isTaskRunning: (taskId: string) => boolean;
  readonly dispatchTask: (task: Task) => Promise<void>;
}

interface DurableRunRequestedCallbackDependencies {
  readonly dispatchPendingRuns: () => Promise<void>;
  readonly requestSchedulerTick?: () => void;
}

export async function dispatchPendingRuns(
  deps: PendingRunDispatchDependencies,
  options: PendingRunDispatchOptions = {},
): Promise<readonly Task[]> {
  const pendingRuns = await deps.taskRepo.getPendingRuns(options.staleBefore);
  const dispatchedTasks: Task[] = [];

  for (const pending of pendingRuns) {
    if (pending.assignedWorkerId) {
      continue;
    }
    if (deps.isTaskRunning(pending.id)) {
      continue;
    }

    options.onDispatchingTask?.(pending);
    await deps.dispatchTask(pending);
    dispatchedTasks.push(pending);
  }

  return dispatchedTasks;
}

export function createDurableRunRequestedCallback(
  deps: DurableRunRequestedCallbackDependencies,
): () => Promise<void> {
  return async () => {
    await deps.dispatchPendingRuns();
    deps.requestSchedulerTick?.();
  };
}
