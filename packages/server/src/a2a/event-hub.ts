import type { AgentEvent, Task } from '../types.js';

/**
 * In-process fan-out of board activity to A2A subscribers.
 *
 * Board work is reported from two places — the in-process `AgentManager` and
 * the worker event ingress — and both already funnel through the WebSocket
 * `broadcast()`. Teeing there gives one choke point that covers both, instead
 * of a second notification path per execution route that the next execution
 * route would forget to call.
 *
 * Deliberately in-memory and per-process: an A2A stream is a live connection
 * to *this* server, so a subscriber only ever needs events this process sees.
 * Durable history stays in the event repository, which `GetTask` reads.
 */

export type BoardActivity =
  | { readonly kind: 'event'; readonly event: AgentEvent }
  | { readonly kind: 'task'; readonly task: Task };

type Listener = (activity: BoardActivity) => void;

/**
 * Guards against a subscriber leak turning into unbounded memory: every
 * subscription is tied to an open A2A stream, and a board with thousands of
 * them is misconfigured rather than busy.
 */
export const MAX_SUBSCRIBED_TASKS = 500;

export class BoardEventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  /**
   * Returns an unsubscribe function. A task at capacity is refused rather than
   * evicting an existing subscriber, so an established stream never goes
   * silent because a new one arrived.
   */
  subscribe(taskId: string, listener: Listener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      if (this.listeners.size >= MAX_SUBSCRIBED_TASKS) return () => {};
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(taskId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(taskId);
    };
  }

  publish(activity: BoardActivity): void {
    const taskId = activity.kind === 'event' ? activity.event.taskId : activity.task.id;
    const set = this.listeners.get(taskId);
    if (!set) return;
    for (const listener of [...set]) {
      // One subscriber's failure must not stop delivery to the others, and
      // must not propagate into the caller — this runs inside broadcast().
      try {
        listener(activity);
      } catch (error) {
        console.error(`[a2a] subscriber for task ${taskId} threw:`, error);
      }
    }
  }

  /** Number of tasks with at least one subscriber (diagnostics and tests). */
  get subscribedTaskCount(): number {
    return this.listeners.size;
  }

  hasSubscribers(taskId: string): boolean {
    return (this.listeners.get(taskId)?.size ?? 0) > 0;
  }
}

/** Process-wide hub used by the WebSocket tee and the A2A router. */
export const boardEvents = new BoardEventHub();
