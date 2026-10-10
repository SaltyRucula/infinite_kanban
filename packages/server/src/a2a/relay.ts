import { AgentEvent as SdkAgentEvent, type ExecutionEventBus } from '@a2a-js/sdk/server';
import { Role, TaskState, type TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { agentEventToTaskUpdate } from '@ai-agent-board/a2a/events.js';
import { isTerminalTaskState, toTaskState } from '@ai-agent-board/a2a/state.js';
import { BOARD_EXTENSION_URI } from '@ai-agent-board/a2a/extension.js';
import type { BoardEventHub } from './event-hub.js';
import type { CancellationLog } from './cancellations.js';
import type { Task } from '../types.js';

/**
 * Relays a board run onto an A2A event bus for as long as the run lasts.
 *
 * Without this, a stream (`SendStreamingMessage`) or a resubscribe
 * (`TaskSubscription`) sees the admitted task and then silence, because the
 * board executes work *after* the request returns — a run can take an hour.
 * Progress therefore arrives here from the board's own event stream and is
 * translated with the same mapping the rest of the board uses, so a peer that
 * streams and a peer that polls `GetTask` observe the same run.
 *
 * The relay owns the bus's lifetime for its task: it publishes a final status
 * update and calls `finished()` when the run reaches a terminal state, so a
 * subscriber sees a stream that ends rather than a connection that hangs.
 */

export interface TaskRelayOptions {
  readonly taskId: string;
  readonly contextId: string;
  readonly eventBus: ExecutionEventBus;
  readonly hub: BoardEventHub;
  readonly cancellations: CancellationLog;
  /** Current board state of the task, read when the relay has to end early. */
  readonly loadTask: (taskId: string) => Promise<Task | undefined>;
  /**
   * Safety net for a run that never reports a terminal state (a crashed
   * worker, a provider that dies mid-run). Without it the subscription, and
   * the bus, would live for the lifetime of the process.
   */
  readonly maxDurationMs?: number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}

/** 25 hours: beyond the maximum task timeout (240 minutes) plus any retry. */
export const DEFAULT_RELAY_MAX_DURATION_MS = 25 * 60 * 60 * 1000;

function statusUpdate(
  taskId: string,
  contextId: string,
  state: TaskState,
  text: string | undefined,
  timestamp: number,
): TaskStatusUpdateEvent {
  return {
    taskId,
    contextId,
    status: {
      state,
      ...(text
        ? {
            message: {
              messageId: `${taskId}-final-${timestamp}`,
              contextId,
              taskId,
              role: Role.ROLE_AGENT,
              parts: [{ content: { $case: 'text' as const, value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
              metadata: undefined,
              extensions: [BOARD_EXTENSION_URI],
              referenceTaskIds: [],
            },
          }
        : {}),
      timestamp: new Date(timestamp).toISOString(),
    },
    final: true,
    metadata: {},
  } as unknown as TaskStatusUpdateEvent;
}

/**
 * Starts relaying. Returns a stop function that unsubscribes *without*
 * finishing the bus — what a caller wants when the run was already terminal
 * before the relay began, or when the caller is tearing down for its own
 * reasons and must not claim the run ended.
 */
export function relayTaskUpdates(options: TaskRelayOptions): () => void {
  const {
    taskId,
    contextId,
    eventBus,
    hub,
    cancellations,
    loadTask,
    maxDurationMs = DEFAULT_RELAY_MAX_DURATION_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  let stopped = false;
  let unsubscribe = (): void => {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeoutFn(timer);
    unsubscribe();
  };

  const stateOf = (task: Task): TaskState => toTaskState(
    { agentStatus: task.agentStatus, columnId: task.columnId },
    cancellations.has(taskId) ? { canceled: true } : {},
  );

  const finish = (task: Task): void => {
    if (stopped) return;
    const timestamp = task.completedAt ?? Date.now();
    eventBus.publish(SdkAgentEvent.statusUpdate(
      statusUpdate(taskId, contextId, stateOf(task), task.summary ?? undefined, timestamp),
    ));
    stop();
    eventBus.finished();
  };

  timer = setTimeoutFn(() => {
    if (stopped) return;
    // Report where the run actually stands and end the stream. Ending beats
    // holding a subscriber on a run that will never report again; claiming a
    // state the board does not hold would be worse than either.
    void loadTask(taskId)
      .then((task) => {
        if (stopped) return;
        const state = task ? stateOf(task) : TaskState.TASK_STATE_UNSPECIFIED;
        eventBus.publish(SdkAgentEvent.statusUpdate(
          statusUpdate(taskId, contextId, state, task?.summary ?? undefined, Date.now()),
        ));
      })
      .catch(() => {
        if (stopped) return;
        eventBus.publish(SdkAgentEvent.statusUpdate(
          statusUpdate(taskId, contextId, TaskState.TASK_STATE_UNSPECIFIED, undefined, Date.now()),
        ));
      })
      .finally(() => {
        if (stopped) return;
        stop();
        eventBus.finished();
      });
  }, maxDurationMs);
  // A pending timer must never be a reason for the process to stay alive: this
  // one can be 25 hours out, and an idle server (or a test run) has to be able
  // to exit while a stream is open.
  (timer as { unref?: () => void }).unref?.();

  unsubscribe = hub.subscribe(taskId, (activity) => {
    if (stopped) return;

    if (activity.kind === 'event') {
      const update = agentEventToTaskUpdate(activity.event, { contextId });
      eventBus.publish(
        update.kind === 'statusUpdate'
          ? SdkAgentEvent.statusUpdate(update.data)
          : SdkAgentEvent.artifactUpdate(update.data),
      );
      return;
    }

    if (isTerminalTaskState(stateOf(activity.task))) finish(activity.task);
  });

  return stop;
}
