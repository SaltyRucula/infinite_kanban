import { DefaultExecutionEventBusManager, type ExecutionEventBus, type ServerCallContext, type User } from '@a2a-js/sdk/server';
import type { TaskState } from '@a2a-js/sdk';

/**
 * Who is calling, and whether they asked for a stream.
 *
 * The board admits work and returns — the run happens elsewhere and can take
 * an hour — so the right lifetime for an execution bus depends on the call:
 *
 * - a blocking `SendMessage` must get the admitted task back immediately, so
 *   the bus has to settle as soon as the executor returns (the SDK's blocking
 *   path waits for the whole drain);
 * - a `SendStreamingMessage` or `SubscribeToTask` must keep the bus open, or
 *   the stream ends on the admitted task and progress never arrives.
 *
 * A global `keepBusAliveStates` cannot express that difference: it would hang
 * every blocking send. The streaming intent is therefore captured per request
 * and carried on the user, which is the only request-scoped value the SDK
 * hands to both the executor and the bus manager.
 */
export class A2APeerUser implements User {
  constructor(
    private readonly principal: string,
    readonly streaming: boolean,
    private readonly authenticated: boolean,
  ) {}

  get isAuthenticated(): boolean { return this.authenticated; }
  get userName(): string { return this.principal; }
}

/** Reads the streaming marker back off a call context, wherever it surfaces. */
export function isStreamingCall(context: { user?: User } | undefined): boolean {
  const user = context?.user as { streaming?: unknown } | undefined;
  return user?.streaming === true;
}

/**
 * Keeps an execution bus alive for streaming callers only.
 *
 * Returning `true` takes ownership of the bus: the relay then owns its
 * lifetime and finishes it when the run reaches a terminal state. Returning
 * `false` leaves the SDK's own state-based policy in charge, which settles the
 * bus immediately — exactly what a blocking send needs.
 */
export class BoardEventBusManager extends DefaultExecutionEventBusManager {
  settleByTaskId(
    _taskId: string,
    _eventBus: ExecutionEventBus,
    _lastObservedState: TaskState | undefined,
    context: ServerCallContext,
  ): boolean {
    return isStreamingCall(context);
  }
}
