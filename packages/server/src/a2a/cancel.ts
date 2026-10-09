import type { TaskRepository } from '../repositories/types.js';
import type { AgentManager } from '../services/agent-manager.js';
import { broadcastTaskUpdate } from '../routes/helpers.js';
import type { CancellationLog } from './cancellations.js';
import type { Task } from '../types.js';

export interface CancelBoardTaskDeps {
  readonly taskRepo: TaskRepository;
  readonly agents: AgentManager;
  readonly cancellations: CancellationLog;
}

/**
 * Cancels a board task on behalf of an A2A peer: stop the run, record the
 * cancellation so the task projects as `TASK_STATE_CANCELED`, and settle the
 * card as failed — the board's own representation of a stopped run, which
 * keeps it retryable in the UI.
 *
 * Shared by both cancellation paths: the executor's `cancelTask` (when an
 * execution event bus is still alive for the task) and the task store's
 * observation of a cancelled status (when it is not).
 */
export async function cancelBoardTask(deps: CancelBoardTaskDeps, taskId: string): Promise<Task | undefined> {
  const task = await deps.taskRepo.getById(taskId);
  if (!task) return undefined;

  deps.cancellations.mark(taskId);
  await deps.agents.stopAgent(taskId);
  const settled = task.agentStatus === 'complete' || task.agentStatus === 'failed'
    ? task
    : await deps.taskRepo.update(taskId, { agentStatus: 'failed', completedAt: Date.now() }) ?? task;
  broadcastTaskUpdate(settled);
  return settled;
}
