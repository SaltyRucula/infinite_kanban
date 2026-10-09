const MAX_TRACKED_CANCELLATIONS = 500;

/**
 * Remembers which tasks were cancelled over A2A.
 *
 * A2A distinguishes `TASK_STATE_CANCELED` from `TASK_STATE_FAILED`, and
 * `CancelTask` is required to report the cancelled state back (spec §3.1.5).
 * The board has no cancelled status of its own — a stopped run is recorded as
 * `failed`, which keeps it retryable in the UI — so the distinction is kept
 * here and applied when projecting the task for a peer.
 *
 * Deliberately in-memory and bounded: a cancellation that outlives a server
 * restart degrades to `failed`, which is the board's own truth. Promoting
 * cancellation to a first-class task state is a board-model change, not a
 * protocol one.
 */
export class CancellationLog {
  private readonly ids = new Set<string>();

  mark(taskId: string): void {
    if (this.ids.size >= MAX_TRACKED_CANCELLATIONS) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.add(taskId);
  }

  has(taskId: string): boolean {
    return this.ids.has(taskId);
  }
}
