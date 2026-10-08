import { TaskState } from '@a2a-js/sdk';
import type { AgentStatus, ColumnId } from '@ai-agent-board/shared/types.js';

/**
 * The board's own lifecycle: `agentStatus` says what the executor is doing,
 * `columnId` says where the card sits. A2A collapses both into a single
 * `TaskState`, so the mapping reads `agentStatus` first and only consults the
 * column where the status alone is ambiguous.
 *
 * See `docs/specs/a2a-protocol-adoption.md` §4.1.
 */
export interface BoardLifecycle {
  readonly agentStatus: AgentStatus;
  readonly columnId: ColumnId;
}

export interface TaskStateOverrides {
  /** The run was cancelled by a human or by `CancelTask`, not by an error. */
  readonly canceled?: boolean;
  /** The request was refused at admission (unknown project, agent unavailable). */
  readonly rejected?: boolean;
}

/** Board task lifecycle → A2A `TaskState`. */
export function toTaskState(lifecycle: BoardLifecycle, overrides: TaskStateOverrides = {}): TaskState {
  if (overrides.rejected) return TaskState.TASK_STATE_REJECTED;
  if (overrides.canceled) return TaskState.TASK_STATE_CANCELED;

  switch (lifecycle.agentStatus) {
    case 'idle':
      // Queued work that no executor has picked up yet. A finished card that
      // was dragged back to backlog is still, from a peer's point of view, a
      // submitted task.
      return TaskState.TASK_STATE_SUBMITTED;
    case 'planning':
    case 'executing':
      return TaskState.TASK_STATE_WORKING;
    case 'awaiting_clarification':
      return TaskState.TASK_STATE_INPUT_REQUIRED;
    case 'complete':
      return TaskState.TASK_STATE_COMPLETED;
    case 'failed':
      return TaskState.TASK_STATE_FAILED;
    default: {
      const unreachable: never = lifecycle.agentStatus;
      throw new Error(`unhandled agentStatus: ${String(unreachable)}`);
    }
  }
}

/** True when no further progress is possible for this A2A state. */
export function isTerminalTaskState(state: TaskState): boolean {
  return state === TaskState.TASK_STATE_COMPLETED
    || state === TaskState.TASK_STATE_FAILED
    || state === TaskState.TASK_STATE_CANCELED
    || state === TaskState.TASK_STATE_REJECTED;
}

/** True when the task is waiting on someone outside the executor. */
export function isInterruptedTaskState(state: TaskState): boolean {
  return state === TaskState.TASK_STATE_INPUT_REQUIRED
    || state === TaskState.TASK_STATE_AUTH_REQUIRED;
}

/**
 * A2A `TaskState` → board lifecycle, for states reported by a remote A2A
 * executor. `columnId` is only returned where A2A forces it (the clarification
 * pause lives in `pending`, a completed run lands in `review`); otherwise the
 * board keeps whatever column the card is already in.
 */
export function fromTaskState(state: TaskState): { agentStatus: AgentStatus; columnId?: ColumnId } {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return { agentStatus: 'idle' };
    case TaskState.TASK_STATE_WORKING:
      return { agentStatus: 'executing', columnId: 'in-progress' };
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return { agentStatus: 'awaiting_clarification', columnId: 'pending' };
    case TaskState.TASK_STATE_COMPLETED:
      return { agentStatus: 'complete', columnId: 'review' };
    case TaskState.TASK_STATE_FAILED:
    case TaskState.TASK_STATE_CANCELED:
    case TaskState.TASK_STATE_REJECTED:
      // The board has no cancelled/rejected status; such runs read as failed
      // and are retryable, which is what the UI already expects.
      return { agentStatus: 'failed' };
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      // No in-task auth flow yet (spec §7.6); treat as a blocking question so
      // the run surfaces to a human instead of silently dying.
      return { agentStatus: 'awaiting_clarification', columnId: 'pending' };
    case TaskState.TASK_STATE_UNSPECIFIED:
    case TaskState.UNRECOGNIZED:
    default:
      return { agentStatus: 'failed' };
  }
}
