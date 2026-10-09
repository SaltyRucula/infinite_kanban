import { Role, TaskState, type Message, type Task as A2ATask } from '@a2a-js/sdk';
import { toTaskState } from '@ai-agent-board/a2a/state.js';
import { BOARD_EXTENSION_URI, EXT_TASK_CONTRACT } from '@ai-agent-board/a2a/extension.js';
import type { Task } from '../types.js';

/**
 * The A2A `contextId` groups related tasks and messages. A board task group is
 * exactly that grouping, so a grouped task reports its group; a standalone task
 * is its own context.
 */
export function contextIdFor(task: Task): string {
  return task.groupId ?? `task-${task.id}`;
}

function statusMessage(task: Task, contextId: string): Message | undefined {
  const text = task.agentStatus === 'awaiting_clarification'
    ? task.clarificationRequest?.prompt
    : task.summary ?? undefined;
  if (!text) return undefined;
  return {
    messageId: `${task.id}-status-${task.completedAt ?? task.startedAt ?? task.createdAt}`,
    contextId,
    taskId: task.id,
    role: Role.ROLE_AGENT,
    parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata: undefined,
    extensions: [BOARD_EXTENSION_URI],
    referenceTaskIds: [],
  };
}

export interface ProjectionOptions {
  /** Absolute link to the card, so a human can follow the work the agent delegated. */
  readonly deepLink?: string;
  readonly canceled?: boolean;
  readonly rejected?: boolean;
}

/**
 * Board task → A2A task. Board-private fields (repo path, worktree path,
 * worker assignment) are never projected; the deep link is the only board
 * location a peer receives.
 */
export function toA2ATask(task: Task, options: ProjectionOptions = {}): A2ATask {
  const contextId = contextIdFor(task);
  const state = toTaskState(
    { agentStatus: task.agentStatus, columnId: task.columnId },
    { ...(options.canceled ? { canceled: true } : {}), ...(options.rejected ? { rejected: true } : {}) },
  );
  const timestamp = new Date(task.completedAt ?? task.startedAt ?? task.createdAt).toISOString();
  return {
    id: task.id,
    contextId,
    status: { state, message: statusMessage(task, contextId), timestamp },
    artifacts: [],
    history: [],
    metadata: {
      [EXT_TASK_CONTRACT]: {
        projectId: task.projectId,
        column: task.columnId,
        agentStatus: task.agentStatus,
        ...(task.agentType ? { agentType: task.agentType } : {}),
        ...(task.branchName ? { branchName: task.branchName } : {}),
        ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}),
        ...(task.labels.length ? { labels: task.labels } : {}),
        ...(options.deepLink ? { deepLink: options.deepLink } : {}),
      },
    },
  };
}

/** True when the A2A view of this task can no longer change. */
export function isFinished(task: A2ATask): boolean {
  const state = task.status?.state;
  return state === TaskState.TASK_STATE_COMPLETED
    || state === TaskState.TASK_STATE_FAILED
    || state === TaskState.TASK_STATE_CANCELED
    || state === TaskState.TASK_STATE_REJECTED;
}
