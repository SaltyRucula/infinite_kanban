import type { AgentEvent as CoreEvent } from '@codewithdan/agent-sdk-core';

export type { CoreEvent };

/**
 * Everything needed to open (or describe) an opencode session, gathered up
 * front instead of scattered across per-prompt call sites.
 *
 * Why this exists: opencode v1's HTTP API is stateless per-prompt — every
 * `session.prompt()` call must resend `agent`/`system`/`model`/`tools`
 * itself, so today's code (pre-adapter) rebuilds that body inline at every
 * call site. opencode v2 moves `agent`/`model`/`permissions` to
 * session-CREATE time instead (and drops the `tools` knob entirely). By
 * hoisting all of it into one spec object now, a future v2 adapter can send
 * the model/agent/permission fields exactly once, at `createSession()` time,
 * without any caller (local-runner, non-destructive-provider) needing to
 * change how it builds this object. See v1-adapter.ts for how v1 honours
 * this spec (it stores it and treats it purely as *default* values that
 * `runTurn`'s `opts` may override per turn — v1 has no session-scoped
 * config, so "session-scoped" is emulated by resending it on every turn
 * unless a turn opts out).
 */
export type SessionSpec = {
  readonly title: string;
  readonly directory: string;
  readonly agent?: string;
  readonly model?: { readonly providerID: string; readonly modelID: string };
  readonly systemPrompt?: string;
  readonly headlessPermissions: boolean;
  /** v1's `tools` knob (disable-by-name map). v2 has no equivalent — it maps permissions differently; that mapping is chunk 2's problem. */
  readonly disabledTools?: Readonly<Record<string, boolean>>;
};

export type TurnOpts = {
  /** Per-turn override for SessionSpec.agent. Falls back to the spec's value when omitted. */
  readonly agent?: string;
  /** Per-turn override for SessionSpec.model. Falls back to the spec's value when omitted. */
  readonly model?: { readonly providerID: string; readonly modelID: string };
  /**
   * Per-turn override for SessionSpec.systemPrompt.
   * - `undefined` (omitted): use the session's default from SessionSpec.
   * - `null`: send **no** system prompt for this turn, even though the
   *   session has a default. v1's follow-up/clarification-answer prompts do
   *   this deliberately — the session already has full context from the
   *   first prompt, so resending the system text every time is unnecessary
   *   chatter, not a functional requirement. Without this explicit
   *   three-state distinction, an adapter that "helpfully" resent the spec's
   *   systemPrompt by default would change v1's on-the-wire request bodies
   *   for follow-up turns — a real (if likely harmless) behaviour change
   *   this refactor must not introduce.
   * - a string: send this exact system prompt for this turn only.
   */
  readonly systemPrompt?: string | null;
  /** Per-turn override for SessionSpec.disabledTools. Falls back to the spec's value when omitted. */
  readonly disabledTools?: Readonly<Record<string, boolean>>;
};

export type TurnResult = { readonly text: string; readonly error?: string };

/**
 * A tool call awaiting a human/agent answer (v2's structured question
 * mechanism, not yet implemented — see chunk 2). v1 has no equivalent API:
 * its `question` tool is TUI-only and is disabled entirely for headless
 * runs (see HEADLESS_DISABLED_TOOLS in the worker), so `pendingQuestions`
 * always resolves `[]` and `settleQuestion` is a no-op on the v1 adapter.
 */
export type PendingQuestion = { readonly id: string; readonly text: string };

export type SessionSummary = { readonly id: string; readonly title: string; readonly updated: number };

/**
 * Uniform contract both the worker's local-runner and the server's
 * non-destructive-provider drive an opencode server through, regardless of
 * whether it turns out to be v1 (this build) or v2+ (chunk 2, not yet
 * implemented — spawning currently throws a fatal error for v2, see
 * spawn.ts).
 */
export interface OpenCodeAdapter {
  readonly apiVersion: 1 | 2;

  createSession(spec: SessionSpec): Promise<string>;

  /** Resume probe: resolves the session id if it still exists, else `null`. Never throws for "not found" — only for transport-level failures. */
  getSession(id: string): Promise<string | null>;

  listSessions(): Promise<SessionSummary[]>;

  deleteSession(id: string): Promise<void>;

  /**
   * Runs one assistant turn and **resolves only once it is complete** — this
   * is the core contract callers (in particular the worker's 60s stall
   * detector, which races this promise against a timer) depend on.
   *
   * On v1 this is trivially true: `session.prompt()` itself is
   * synchronous-until-done, so `runTurn` just awaits it directly.
   *
   * v2's `POST /api/session/{id}/prompt` is **asynchronous** — it admits the
   * user message and returns in ~10ms with no assistant output at all; true
   * completion is signalled later via `session.execution.succeeded|failed`
   * SSE events. A v2 adapter's `runTurn` MUST internally await that
   * completion signal before resolving (e.g. by racing/joining its own SSE
   * subscription) rather than returning as soon as the HTTP call responds.
   * Getting this wrong would silently turn every "turn complete" signal in
   * both callers into "turn admitted", which is chunk 2's single biggest
   * regression risk — flagged here so it isn't rediscovered the hard way.
   */
  runTurn(id: string, text: string, opts?: TurnOpts): Promise<TurnResult>;

  interrupt(id: string): Promise<void>;

  /**
   * Yields mapped core events for one session, already filtered to that
   * session id, until `signal` aborts. (Deviates slightly from a
   * connection-wide `subscribe(signal)` shape: v1's raw SSE feed is
   * connection-wide and unfiltered, and mapping requires a session id to
   * filter by, so the id is a required parameter here rather than assumed
   * from adapter construction — this keeps one adapter usable for many
   * concurrent sessions, matching how non-destructive-provider already
   * uses a single client connection across many opencode sessions.)
   */
  subscribe(id: string, signal: AbortSignal): AsyncIterable<CoreEvent>;

  pendingQuestions(id: string): Promise<PendingQuestion[]>;

  settleQuestion(id: string, question: PendingQuestion, answer: string): Promise<void>;
}
