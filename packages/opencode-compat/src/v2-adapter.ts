import {
  classifyV2InputRequest,
  classifyV2Terminal,
  mapV2Event,
  sessionIdOf,
  type V2RawEvent,
} from './v2-events.js';
import type {
  CoreEvent,
  OpenCodeAdapter,
  PendingQuestion,
  SessionSpec,
  SessionSummary,
  TurnOpts,
  TurnResult,
} from './types.js';

type TerminalOutcome = 'succeeded' | 'failed' | 'interrupted';

type InputRequest =
  | { readonly kind: 'form'; readonly formID: string }
  | { readonly kind: 'permission'; readonly requestID: string };

/**
 * Resolved signal a turn's internal SSE listener can settle with: either a
 * normal terminal execution event, or the anti-hang watcher deciding to
 * park the turn on a pending form/permission (see `createV2Adapter`'s
 * module doc comment and `runTurn`'s listener below). Kept distinct from
 * `TerminalOutcome` because parking is not one of v2's own terminal event
 * types — it is this adapter's own decision to stop waiting.
 */
type TurnSignal =
  | { readonly kind: 'terminal'; readonly outcome: TerminalOutcome; readonly error?: string }
  | { readonly kind: 'input-request'; readonly question: string };

function eventSessionId(event: V2RawEvent): string {
  return sessionIdOf(event, asRecord(event.data));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** v2's `Permission.Rule` shape (`{action, resource, effect}`). */
export type V2PermissionRule = { readonly action: string; readonly resource: string; readonly effect: 'allow' | 'deny' };

/**
 * Maps v1-style disabled-tool names onto v2's *empirically verified*
 * ruleset action vocabulary (see SPIKE-FINDINGS.md Spike 2). Deliberately
 * excludes `bash`/`write`/`patch` as standalone actions — all three were
 * verified to have **no runtime effect** in opencode v2.0.12 even though
 * the server silently accepts them into a ruleset. Using any of them
 * instead of this table would silently fail to enforce the restriction it
 * looks like it's enforcing.
 */
const TOOL_TO_V2_ACTION: Readonly<Record<string, string>> = {
  edit: 'edit',
  write: 'edit',
  patch: 'edit',
  shell: 'shell',
  bash: 'shell',
  read: 'read',
  webfetch: 'webfetch',
};

/**
 * Builds a v2 `Permission.Ruleset` from `SessionSpec`'s
 * `headlessPermissions`/`disabledTools`. `headlessPermissions: false` omits
 * the `permissions` field entirely (letting the server apply its own
 * default, potentially-interactive behaviour) rather than guessing at a
 * restrictive baseline nobody has asked for yet.
 */
export function buildV2PermissionRuleset(
  headlessPermissions: boolean,
  disabledTools?: Readonly<Record<string, boolean>>,
): V2PermissionRule[] | undefined {
  if (!headlessPermissions) return undefined;
  const rules: V2PermissionRule[] = [{ action: '*', resource: '*', effect: 'allow' }];
  const deniedActions = new Set<string>();
  for (const [tool, enabled] of Object.entries(disabledTools ?? {})) {
    if (enabled === false) {
      const action = TOOL_TO_V2_ACTION[tool];
      if (action) deniedActions.add(action);
    }
  }
  for (const action of deniedActions) {
    rules.push({ action, resource: '*', effect: 'deny' });
  }
  return rules;
}

const SYSTEM_PROMPT_FALLBACK_SEPARATOR = '\n\n---\n\n';
const INSTRUCTIONS_ENTRY_KEY = 'headless';
const DEFAULT_TURN_DEADLINE_MS = 10 * 60 * 1000; // 10 minutes.
const TOOL_NAME_CACHE_LIMIT = 500;

// MUST match `INPUT_REQUEST_MARKER` in packages/worker/src/input-request.ts
// verbatim. The worker's `extractInputRequest` parses this exact marker
// (anchored at the start of the final non-empty line) out of whatever text
// `runTurn` returns to decide whether a task should park as
// `awaiting_input` — that parsing logic already exists and is shared by
// both v1 (where the *model* emits the marker as ordinary text, per the
// system prompt instructing it to) and v2 (where *this adapter* synthesizes
// the marker itself the moment it sees a `form.created`/`permission.asked`
// event it cannot let a human answer — see the module doc comment below).
// Duplicated as a literal, rather than imported, because opencode-compat
// has no dependency on the worker package (the dependency runs the other
// way) — see the equivalent duplication note on TOOL_TO_V2_ACTION above for
// the same "verified, not derived" trade-off in this file.
const NEEDS_INPUT_MARKER = 'NEEDS_INPUT:';

/**
 * Minimal fetch-like contract this adapter depends on. Kept as an explicit
 * seam (mirroring v1-adapter's `OpenCodeClientLike`) so tests can supply a
 * fake without opening real sockets, and so callers can inject Node's
 * global `fetch` explicitly rather than this file reaching for it
 * implicitly.
 */
export type FetchLike = typeof fetch;

export type CreateV2AdapterInput = {
  readonly baseUrl: string;
  readonly directory: string;
  /** The per-spawn `OPENCODE_SERVER_PASSWORD`. Paired with the fixed username `opencode` for HTTP Basic auth. Never logged. */
  readonly password: string;
  /** Injectable fetch implementation (test seam). Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /**
   * Absolute wall-clock deadline for a single `runTurn()` call, guarding
   * against a dropped/stalled SSE connection leaving `runTurn` unresolved
   * forever (v2 has no outer-HTTP-timeout backstop the way v1's
   * synchronous `session.prompt()` implicitly did — see the doc comment on
   * `OpenCodeAdapter.runTurn`). Defaults to 10 minutes.
   */
  readonly turnDeadlineMs?: number;
};

/**
 * Reads exactly one `text/event-stream` connection to `/api/event` and fans
 * out parsed envelopes to any number of listeners. One instance is shared
 * per adapter (not per session/per turn) so that `subscribe()` callers and
 * `runTurn()`'s own internal wait for a terminal event share the same
 * physical connection, and so `runTurn` can register its listener and be
 * guaranteed to observe events emitted after that point — this is what
 * "attach to the event stream before POSTing the prompt" means in practice
 * here: `ensureConnected()` resolves once the HTTP response headers for the
 * SSE stream are in, and only after that does any code path proceed to
 * register a listener and issue the prompt POST.
 */
class V2EventStream {
  private connectPromise: Promise<void> | undefined;
  private readonly listeners = new Set<(event: V2RawEvent) => void>();
  private readonly aborter = new AbortController();

  constructor(
    private readonly baseUrl: string,
    private readonly authHeader: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  async ensureConnected(): Promise<void> {
    if (!this.connectPromise) {
      this.connectPromise = this.connect();
    }
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/event`, {
      headers: { Authorization: this.authHeader },
      signal: this.aborter.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`opencode v2 event stream request failed with status ${response.status}`);
    }
    void this.pump(response.body);
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separatorIndex: number;
        while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          this.dispatchFrame(frame);
        }
      }
    } catch {
      // Connection dropped or aborted. Listeners waiting on a specific
      // event (runTurn's terminal wait, subscribe()'s consumers) are
      // responsible for their own timeout/abort handling — this class does
      // not retry, matching v1's `sseMaxRetryAttempts: 0` behaviour.
    }
  }

  private dispatchFrame(frame: string): void {
    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (dataLines.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    const record = asRecord(parsed);
    if (!record || typeof record.type !== 'string') return;
    const event = record as unknown as V2RawEvent;
    for (const listener of this.listeners) listener(event);
  }

  /** Returns an unsubscribe function. */
  addListener(listener: (event: V2RawEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.aborter.abort();
  }
}

type SessionState = {
  /**
   * Set when the Tier 1 system-prompt write (`PUT .../instructions/entries`)
   * did not return a 2xx at `createSession` time. Holds the text still
   * owed to the model via the Tier 2 fallback (prepending to the first
   * prompt). Cleared (set to `null`) the first time `runTurn` runs for this
   * session, regardless of whether that turn actually used it (e.g. an
   * explicit per-turn `opts.systemPrompt` override took precedence) —
   * "the first prompt only" is a property of the session's lifecycle, not
   * of any one call's options.
   */
  pendingSystemPromptFallback: string | null;
};

function extractErrorMessage(error: unknown): string {
  const record = asRecord(error);
  if (record && typeof record.message === 'string') return record.message;
  if (record && typeof record.type === 'string') return record.type;
  return 'opencode v2 session execution failed';
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Builds the headless-safe question text embedded in the `NEEDS_INPUT:`
 * marker for a form/permission the anti-hang watcher just decided to park
 * on (see `runTurn`'s listener). Reuses `mapV2Event`'s own content-building
 * logic (`mapFormCreated`/`mapPermissionAsked`) rather than duplicating it,
 * so the text shown to a human answering later matches exactly what the
 * live event stream already surfaced as a `clarification_request`.
 * Collapses whitespace/newlines defensively — the marker-line convention
 * (see NEEDS_INPUT_MARKER) requires the question to stay on one line.
 */
function buildInputRequestQuestion(event: V2RawEvent, request: InputRequest): string {
  const mapped = mapV2Event(event);
  const content = mapped?.content?.trim();
  if (content) return content.replace(/\s+/g, ' ');
  return request.kind === 'form' ? 'opencode is waiting for input' : 'opencode is waiting for a permission decision';
}

/**
 * Wraps opencode v2's plain HTTP+SSE API behind the `OpenCodeAdapter`
 * contract. Deliberately implemented with plain `fetch` rather than
 * `@opencode-ai/sdk/v2` — that generated client was verified (see
 * SPIKE-FINDINGS.md) to be drifted from opencode 2.0.12 (double-prefixes
 * `/api`, calls endpoints that don't exist).
 *
 * ## The anti-hang watcher (why this adapter is safe to run headlessly)
 * v2 has two distinct "wait on a human forever" mechanisms with no
 * HTTP-level timeout backstop: `form.created` and `permission.asked` (see
 * `classifyV2InputRequest`'s doc comment). `runTurn`'s internal SSE
 * listener watches for both, in addition to the three terminal execution
 * events, and on the FIRST one seen for a turn:
 *   1. Sends a "safety net" reply so the pending form/permission can never
 *      wedge the *session* even if a later turn is sent before a human
 *      answers through the board — a permission is rejected
 *      (`{decision: "reject"}`, the only safe headless answer: there is no
 *      human to grant it), a single-field form is answered with an empty
 *      string for its one known field, and any other form shape is
 *      force-closed via `DELETE` instead of guessing at an unknown
 *      multi-field answer. `runTurn` awaits this reply before resolving
 *      (see `finish()`) so that, by the time a caller sees the parked
 *      result, the wedge-prevention has actually landed — but the
 *      deadline timer (below) is deliberately still armed during this
 *      wait, so a reply call that itself hangs cannot reintroduce the very
 *      indefinite hang this whole mechanism exists to prevent.
 *   2. Resolves the turn (without waiting for a terminal execution event)
 *      with a synthesized `NEEDS_INPUT:` marker line appended to whatever
 *      text the turn had already produced — this is deliberately routed
 *      through the EXISTING `extractInputRequest` marker convention (see
 *      NEEDS_INPUT_MARKER above) so local-runner.ts's `awaiting_input`
 *      handling works completely unchanged for v2, exactly as it already
 *      does for v1.
 * Bullet 2 (parking) is the primary UX — it is what lets a human actually
 * answer the question through the board. Bullet 1 (settling) is the safety
 * net: it exists so that if a second prompt is later sent to this same
 * session (e.g. the human's answer, resumed), the still-pending
 * form/permission from before cannot silently wedge that new turn too.
 *
 * Absent either mechanism firing, `turnDeadlineMs` is the hard backstop
 * against a dropped/stalled SSE connection (see `CreateV2AdapterInput`'s
 * doc comment) — together, the watcher and the deadline mean `runTurn` can
 * only ever resolve, reject on a bounded deadline, or park; it cannot hang
 * indefinitely on a human who was never there to answer.
 */
export function createV2Adapter(input: CreateV2AdapterInput): OpenCodeAdapter {
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  const fetchImpl = input.fetchImpl ?? fetch;
  const authHeader = `Basic ${Buffer.from(`opencode:${input.password}`, 'utf8').toString('base64')}`;
  const turnDeadlineMs = input.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS;
  const eventStream = new V2EventStream(baseUrl, authHeader, fetchImpl);
  const sessions = new Map<string, SessionState>();

  // Correlates a tool call id to its name (only ever seen on
  // `session.tool.input.started`, never repeated on `.called`/`.success`/
  // `.failed`) so `mapV2Event` can name a tool call by fact instead of by
  // input-shape heuristic alone in its generic fallback branch (see
  // mapToolCalled's doc comment in v2-events.ts). Registered once, at
  // adapter-construction time, independent of any one session's
  // subscribe()/runTurn listeners — `.input.started` always precedes the
  // events that consult this map for the same call id, since they are
  // steps of the same tool invocation emitted in a fixed order by the
  // server. Bounded (evicting the oldest entry once full, matching the
  // dedup-cache pattern in non-destructive-provider.ts) so a very
  // long-running session cannot grow this unboundedly.
  const toolCallNames = new Map<string, string>();
  eventStream.addListener((event) => {
    if (event.type !== 'session.tool.input.started') return;
    const callId = asString(event.data?.id);
    const name = asString(event.data?.name);
    if (!callId || !name) return;
    if (!toolCallNames.has(callId) && toolCallNames.size >= TOOL_NAME_CACHE_LIMIT) {
      const oldest = toolCallNames.keys().next().value;
      if (oldest !== undefined) toolCallNames.delete(oldest);
    }
    toolCallNames.set(callId, name);
  });

  async function apiFetch(path: string, init: { method: string; body?: unknown }): Promise<Response> {
    return fetchImpl(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: authHeader,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  }

  /**
   * Tier 1 (`PUT /api/experimental/session/{id}/instructions/entries/headless`)
   * with a real Tier 2 fallback (prepend into the first prompt) on any
   * non-2xx response — `experimental/` may vanish in a future opencode
   * version, so the fallback must actually work, not just exist on paper.
   */
  async function applySystemPrompt(sessionId: string, systemPrompt: string): Promise<{ tier1Applied: boolean }> {
    try {
      const response = await apiFetch(`/api/experimental/session/${sessionId}/instructions/entries/${INSTRUCTIONS_ENTRY_KEY}`, {
        method: 'PUT',
        body: { value: systemPrompt },
      });
      return { tier1Applied: response.ok };
    } catch {
      return { tier1Applied: false };
    }
  }

  /**
   * Fire-and-forget-from-the-caller's-perspective, but *awaited* internally
   * by `runTurn` before it resolves (see the `finish()` sequencing below) —
   * a failed reply here never throws, it just means the session-side
   * wedge-prevention did not land; the turn still parks regardless.
   */
  async function settleInputRequestSafetyNet(sessionId: string, event: V2RawEvent, request: InputRequest): Promise<void> {
    try {
      if (request.kind === 'permission') {
        await apiFetch(`/api/session/${sessionId}/permission/${request.requestID}/reply`, {
          method: 'POST',
          body: { decision: 'reject' },
        });
        return;
      }

      const form = asRecord(asRecord(event.data)?.form);
      const fields = asArray(form?.fields) ?? [];
      // Only a single-field form has an unambiguous "the" field to answer;
      // anything else (zero fields, or more than one) is force-closed via
      // DELETE rather than guessing which field(s) an empty/placeholder
      // answer should go to.
      const fieldKey = fields.length === 1 ? asString(asRecord(fields[0])?.key) : undefined;
      if (fieldKey) {
        await apiFetch(`/api/session/${sessionId}/form/${request.formID}/reply`, {
          method: 'POST',
          body: { answer: { [fieldKey]: '' } },
        });
      } else {
        await apiFetch(`/api/session/${sessionId}/form/${request.formID}`, { method: 'DELETE' });
      }
    } catch {
      // best-effort safety net — the turn parks regardless (see finish()).
    }
  }

  return {
    apiVersion: 2,

    async createSession(spec: SessionSpec): Promise<string> {
      const body: Record<string, unknown> = {
        title: spec.title,
        location: { directory: spec.directory },
      };
      if (spec.agent) body.agent = spec.agent;
      if (spec.model) body.model = { providerID: spec.model.providerID, id: spec.model.modelID };
      const permissions = buildV2PermissionRuleset(spec.headlessPermissions, spec.disabledTools);
      if (permissions) body.permissions = permissions;

      const response = await apiFetch('/api/session', { method: 'POST', body });
      if (!response.ok) {
        throw new Error(`opencode v2 session create failed with status ${response.status}`);
      }
      const parsed = asRecord(await readJsonBody(response));
      const id = asRecord(parsed?.data)?.id;
      if (typeof id !== 'string') {
        throw new Error('opencode v2 session create returned no session id');
      }

      let pendingSystemPromptFallback: string | null = null;
      if (spec.systemPrompt) {
        const { tier1Applied } = await applySystemPrompt(id, spec.systemPrompt);
        if (!tier1Applied) pendingSystemPromptFallback = spec.systemPrompt;
      }
      sessions.set(id, { pendingSystemPromptFallback });
      return id;
    },

    async getSession(id: string): Promise<string | null> {
      const response = await apiFetch(`/api/session/${id}`, { method: 'GET' });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`opencode v2 session get failed with status ${response.status}`);
      }
      const parsed = asRecord(await readJsonBody(response));
      const sessionId = asRecord(parsed?.data)?.id;
      return typeof sessionId === 'string' ? sessionId : null;
    },

    async listSessions(): Promise<SessionSummary[]> {
      const response = await apiFetch('/api/session', { method: 'GET' });
      if (!response.ok) {
        throw new Error(`opencode v2 session list failed with status ${response.status}`);
      }
      const parsed = asRecord(await readJsonBody(response));
      const data = Array.isArray(parsed?.data) ? (parsed.data as unknown[]) : [];
      return data
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== undefined)
        .map((entry) => {
          const time = asRecord(entry.time);
          return {
            id: String(entry.id ?? ''),
            title: typeof entry.title === 'string' ? entry.title : '',
            updated: typeof time?.updated === 'number' ? time.updated : 0,
          };
        })
        .filter((summary) => summary.id !== '');
    },

    async deleteSession(id: string): Promise<void> {
      await apiFetch(`/api/session/${id}`, { method: 'DELETE' });
      sessions.delete(id);
    },

    async runTurn(id: string, text: string, opts: TurnOpts = {}): Promise<TurnResult> {
      await eventStream.ensureConnected();

      // NOTE (scope limitation, not yet requested by any caller): v2 has no
      // per-prompt `agent`/`model`/`tools` fields the way v1 does — those
      // are session-scoped, set once at `createSession` time. `opts.agent`,
      // `opts.model`, and `opts.disabledTools` are therefore silently
      // ignored here; only `opts.systemPrompt` has a real per-turn v2
      // mechanism (prepending text, since v2 has no per-prompt `system`
      // field either). If a future caller needs genuine per-turn
      // agent/model switching against v2, `POST /session/{id}/agent` and
      // `/model` exist server-side but are unimplemented in this adapter.
      const state = sessions.get(id);
      const pendingFallback = state?.pendingSystemPromptFallback ?? null;
      if (state) state.pendingSystemPromptFallback = null; // consumed on the first runTurn call, regardless of outcome below.

      let promptText = text;
      if (opts.systemPrompt === null) {
        // Explicit per-turn suppression — send exactly `text`, even if a
        // Tier 2 fallback was pending (mirrors v1's three-state override
        // semantics on TurnOpts.systemPrompt; see its doc comment).
      } else if (typeof opts.systemPrompt === 'string') {
        promptText = `${opts.systemPrompt}${SYSTEM_PROMPT_FALLBACK_SEPARATOR}${text}`;
      } else if (pendingFallback) {
        promptText = `${pendingFallback}${SYSTEM_PROMPT_FALLBACK_SEPARATOR}${text}`;
      }

      // Accumulated assistant text, keyed by `${assistantMessageID}:${ordinal}`
      // so a turn spanning multiple steps/messages is not double-counted
      // from `session.text.delta` (this adapter only reads the authoritative
      // full text from `session.text.ended`) and preserves emission order.
      const textByKey = new Map<string, string>();
      const textOrder: string[] = [];

      let disposeTurnListener: () => void = () => {};
      const turnOutcomePromise = new Promise<TurnSignal>((resolve, reject) => {
        // `decided` guards against processing a second terminal/input-request
        // raw event once an outcome has been chosen (there is exactly one
        // outcome per turn). `settled` guards the promise's own
        // resolve/reject call specifically — kept distinct from `decided`
        // because the input-request path below does async work (the
        // safety-net reply) *between* deciding the outcome and actually
        // resolving, and the deadline timer must still be able to fire
        // during that window if the safety-net call itself hangs (a v2
        // server unresponsive enough to hang a permission/form reply is
        // exactly the kind of dropped/stalled condition turnDeadlineMs
        // exists to bound) — see `finish()` below.
        let decided = false;
        let settled = false;

        const finish = (signal: TurnSignal): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadlineTimer);
          resolve(signal);
        };

        const deadlineTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe();
          reject(
            new Error(
              `opencode v2 turn for session ${id} did not receive a terminal event within ${turnDeadlineMs}ms (dropped or stalled SSE stream)`,
            ),
          );
        }, turnDeadlineMs);

        const unsubscribe = eventStream.addListener((event) => {
          if (eventSessionId(event) !== id) return;

          if (event.type === 'session.text.ended') {
            const assistantMessageID = event.data?.assistantMessageID;
            const ordinal = event.data?.ordinal;
            const key = `${String(assistantMessageID)}:${String(ordinal)}`;
            if (!textByKey.has(key)) textOrder.push(key);
            textByKey.set(key, typeof event.data?.text === 'string' ? event.data.text : '');
            return;
          }

          if (decided) return;

          // Anti-hang watcher (see the module doc comment): a pending
          // form/permission never arrives alongside a terminal execution
          // event — it must be caught here directly, or this turn would
          // otherwise hang until turnDeadlineMs purely because nobody ever
          // classifies it as "done".
          const inputRequest = classifyV2InputRequest(event);
          if (inputRequest) {
            decided = true;
            unsubscribe();
            void settleInputRequestSafetyNet(id, event, inputRequest).finally(() => {
              finish({ kind: 'input-request', question: buildInputRequestQuestion(event, inputRequest) });
            });
            return;
          }

          const terminal = classifyV2Terminal(event);
          if (!terminal) return;
          decided = true;
          unsubscribe();
          const error = terminal === 'failed' ? extractErrorMessage(event.data?.error) : undefined;
          finish({ kind: 'terminal', outcome: terminal, ...(error ? { error } : {}) });
        });

        // Exposed so a failed prompt POST (below) can tear down the timer
        // and listener instead of leaving them to fire/leak later.
        disposeTurnListener = () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadlineTimer);
          unsubscribe();
        };
      });
      // Attaching a no-op catch here (on a *separate* promise chain, not the
      // `turnOutcomePromise` reference itself) prevents an "unhandled
      // rejection" warning if the prompt POST below fails and this turn's
      // outcome is abandoned via `disposeTurnListener()` before anything
      // else observes it — `turnOutcomePromise` is still awaited normally
      // on the success path further down.
      turnOutcomePromise.catch(() => undefined);

      // Only issue the prompt after the listener above is registered (it is
      // registered synchronously inside the `new Promise` executor above,
      // which runs before this line executes) and the SSE connection was
      // confirmed live via `ensureConnected()` earlier — so a fast server
      // can never emit the terminal event before this adapter starts
      // listening for it. Crucially, this line runs *before* awaiting
      // `turnOutcomePromise`: v2's prompt endpoint is what actually causes
      // the server to do any work at all, so waiting on the terminal event
      // before sending the prompt would deadlock against a real server.
      let promptResponse: Response;
      try {
        promptResponse = await apiFetch(`/api/session/${id}/prompt`, { method: 'POST', body: { text: promptText } });
      } catch (error) {
        disposeTurnListener();
        throw error;
      }
      if (!promptResponse.ok) {
        disposeTurnListener();
        throw new Error(`opencode v2 prompt send failed with status ${promptResponse.status}`);
      }

      const signal = await turnOutcomePromise;
      const accumulatedText = textOrder.map((key) => textByKey.get(key) ?? '').join('\n');
      if (signal.kind === 'input-request') {
        // Routed through the same NEEDS_INPUT: marker convention v1's model
        // output already uses (see NEEDS_INPUT_MARKER above) so
        // local-runner.ts's existing extractInputRequest/awaiting_input
        // handling picks this up completely unchanged.
        const marker = `${NEEDS_INPUT_MARKER} ${signal.question}`;
        return { text: accumulatedText ? `${accumulatedText}\n\n${marker}` : marker };
      }
      return { text: accumulatedText, ...(signal.error ? { error: signal.error } : {}) };
    },

    async interrupt(id: string): Promise<void> {
      // v2 has no `/abort` endpoint — `/interrupt` is the only mechanism.
      await apiFetch(`/api/session/${id}/interrupt`, { method: 'POST' });
    },

    subscribe(id: string, signal: AbortSignal): AsyncIterable<CoreEvent> {
      return subscribeMapped(eventStream, id, signal, toolCallNames);
    },

    // GET /api/session/{id}/form lists pending forms. This is a separate,
    // currently-unused-by-any-caller polling API — the actual anti-hang
    // handling for a form/permission that arrives *during* a turn is
    // runTurn's own SSE listener above, which reacts the instant the event
    // arrives rather than waiting to be polled.
    // TODO: also surface pending `permission.asked` requests here (GET
    // /api/session/{id}/permission) if a future caller needs to poll for
    // them — PendingQuestion has no room yet to distinguish the two kinds.
    async pendingQuestions(id: string): Promise<PendingQuestion[]> {
      const response = await apiFetch(`/api/session/${id}/form`, { method: 'GET' });
      if (!response.ok) {
        throw new Error(`opencode v2 form list failed with status ${response.status}`);
      }
      const parsed = asRecord(await readJsonBody(response));
      const data = Array.isArray(parsed?.data) ? (parsed.data as unknown[]) : [];
      return data
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== undefined)
        .map((entry) => {
          const fields = Array.isArray(entry.fields) ? entry.fields : [];
          const firstField = asRecord(fields[0]);
          const text =
            (typeof firstField?.description === 'string' && firstField.description) ||
            (typeof entry.title === 'string' && entry.title) ||
            'opencode is waiting for input';
          return { id: String(entry.id ?? ''), text };
        })
        .filter((question) => question.id !== '');
    },

    async settleQuestion(id: string, question: PendingQuestion, answer: string): Promise<void> {
      // Form.Answer is `Record<string, Form.Value>`; without a mapped field
      // key (chunk 4's job, via classifyV2InputRequest) this answers the
      // form's first/only well-known key. Forms observed in the spike used
      // a single field (`q0`) for a free-text clarifying question, which is
      // the only shape this adapter is expected to answer headlessly today.
      await apiFetch(`/api/session/${id}/form/${question.id}/reply`, {
        method: 'POST',
        body: { answer: { q0: answer } },
      });
    },
  };
}

async function* subscribeMapped(
  eventStream: V2EventStream,
  sessionId: string,
  signal: AbortSignal,
  toolNames: ReadonlyMap<string, string>,
): AsyncGenerator<CoreEvent, void, unknown> {
  await eventStream.ensureConnected();
  const queue: CoreEvent[] = [];
  let wake: (() => void) | undefined;
  const unsubscribe = eventStream.addListener((event) => {
    if (eventSessionId(event) !== sessionId) return;
    // Routed through mapV2Event (see the module doc comment and
    // v2-events.ts) so callers get the same `CoreEvent` shape v1 already
    // produces — mapCoreEvent in local-runner.ts works unchanged for v2 as
    // a result. Events that map to `null` (lifecycle/telemetry noise, or a
    // type this mapper does not recognise) are dropped here, never
    // forwarded raw.
    const mapped = mapV2Event(event, toolNames);
    if (!mapped) return;
    queue.push(mapped);
    wake?.();
  });
  const onAbort = () => wake?.();
  signal.addEventListener('abort', onAbort);
  try {
    while (!signal.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
        continue;
      }
      const next = queue.shift();
      if (next) yield next;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    unsubscribe();
  }
}
