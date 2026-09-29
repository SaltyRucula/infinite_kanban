import { randomUUID } from 'node:crypto';
import type { CoreEvent } from './types.js';

/**
 * Raw shape of one opencode v2 SSE envelope, as observed empirically against
 * a live `opencode serve` v2.0.12 instance (see the chunk-2 spike findings).
 * Lines on the wire are either `data: {...}` SSE frames or bare JSON — this
 * type describes the parsed JSON payload either way.
 *
 * `location.directory` is the session's absolute host workspace path. It is
 * present on almost every event and MUST NEVER be copied into a mapped
 * `CoreEvent` (see the module-level security note below) — it is typed here
 * only so callers can assert its absence in tests.
 */
export type V2RawEvent = {
  id?: string;
  created?: number;
  type: string;
  location?: { directory?: string };
  data?: Record<string, unknown>;
  durable?: unknown;
};

type InputRequest = { readonly kind: 'form'; readonly formID: string } | { readonly kind: 'permission'; readonly requestID: string };

// ---------------------------------------------------------------------------
// Small, defensive helpers. Every one of these is written to never throw —
// malformed/absent fields simply resolve to `undefined`/`false` rather than
// raising, which is what lets mapV2Event's own top-level try/catch (below)
// be a pure belt-and-braces backstop rather than the primary safety net.
// ---------------------------------------------------------------------------

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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Joins the `{type:'text', text}` items of a v2 `content[]` array (used by
 * `session.tool.success`). Non-text items (none observed so far, but the
 * shape is a discriminated union server-side) are silently skipped rather
 * than causing a throw.
 */
function textFromContentArray(content: unknown): string | undefined {
  const items = asArray(content);
  if (!items) return undefined;
  const parts: string[] = [];
  for (const item of items) {
    const text = asString(asRecord(item)?.text);
    if (text !== undefined) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * Resolves the session id to use as `CoreEvent.contextId`. Almost every v2
 * event carries `data.sessionID` directly; `form.created` is the one
 * observed exception (the session id lives one level down, at
 * `data.form.sessionID`, since `data` wraps the whole `Form.Info` object).
 * Falls back to `''` rather than throwing when neither is present —
 * `contextId` is not sanitized/used for security purposes downstream (see
 * v1-adapter.ts's subscribeSession, which already treats it as a
 * best-effort default callers may overwrite), so an empty fallback is safe.
 */
export function sessionIdOf(raw: V2RawEvent, data: Record<string, unknown> | undefined): string {
  const direct = asString(data?.sessionID);
  if (direct) return direct;
  if (raw.type === 'form.created') {
    const nested = asString(asRecord(data?.form)?.sessionID);
    if (nested) return nested;
  }
  return '';
}

/**
 * Builds a `CoreEvent`. This is the ONLY place a mapped event is
 * constructed, and it is deliberately an explicit field whitelist rather
 * than a spread of `raw`/`raw.data` — see the security note above
 * `mapV2Event`. `metadata` is passed through an explicit cast because
 * `AgentEventMetadata` (the upstream SDK's declared type) does not itself
 * declare `clarification_request`/`clarification_answer` even though
 * downstream consumers (packages/worker/src/local-runner.ts's
 * `sanitizeMetadata`) read them by duck-typing `CoreEvent['metadata']` as a
 * plain record. The cast does not widen what we actually emit — the object
 * literal itself is still built field-by-field above each call site.
 */
function build(
  id: string,
  contextId: string,
  type: CoreEvent['type'],
  content: string,
  timestamp: number,
  metadata?: Record<string, unknown>,
): CoreEvent {
  return {
    id,
    contextId,
    type,
    content,
    timestamp,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata: metadata as CoreEvent['metadata'] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Per-event-type mappers
// ---------------------------------------------------------------------------

/**
 * `session.tool.called` carries the call id but, unlike
 * `session.tool.input.started`, does NOT repeat the tool's name — the name
 * is only ever seen on the sibling `.input.started` event for the same call
 * id. `mapV2Event` is still a pure, stateless, one-event-in/one-event-out
 * function by default (no name context) — but callers that maintain their
 * own call-id→name correlation map across the stream (built from
 * `.input.started` events, which fire strictly before the matching
 * `.called`/`.success`/`.failed` — see `createV2Adapter`'s `toolCallNames`)
 * can pass it in as `knownToolName` to disambiguate names that fall outside
 * every shape below. When no name is known (the default, and the case
 * exercised by every test in this file), classification falls back to the
 * *shape* of `data.input`:
 *   - a string `command` field           -> shell-like tool ('command')
 *   - `oldString`+`newString` string keys -> an edit-style tool ('file_edit')
 *   - `path`+`content` string keys        -> a write-style tool ('file_write')
 *   - a lone `path` string key            -> a read-style tool ('file_read')
 *   - anything else                       -> generic ('tool_call'), using
 *     the known name in the message if available, else a raw JSON dump
 * This matches every tool shape observed in the captured fixtures (`shell`,
 * `edit`, `write`) without needing cross-event state, and improves only the
 * generic fallback branch when a name happens to be available — never
 * changes the four well-known branches above, so it cannot regress them.
 */
function mapToolCalled(
  id: string,
  contextId: string,
  timestamp: number,
  data: Record<string, unknown> | undefined,
  knownToolName?: string,
): CoreEvent | null {
  const input = asRecord(data?.input);
  if (!input) return build(id, contextId, 'tool_call', knownToolName ? `${knownToolName} tool called` : 'Tool called', timestamp);

  const command = asString(input.command);
  const path = asString(input.path);
  const hasEditShape = typeof input.oldString === 'string' && typeof input.newString === 'string';
  const hasWriteShape = typeof input.content === 'string';

  if (command !== undefined) {
    return build(id, contextId, 'command', command, timestamp, { command });
  }
  if (path !== undefined && hasEditShape) {
    return build(id, contextId, 'file_edit', `Editing ${path}`, timestamp, { file: path });
  }
  if (path !== undefined && hasWriteShape) {
    return build(id, contextId, 'file_write', `Writing ${path}`, timestamp, { file: path });
  }
  if (path !== undefined) {
    return build(id, contextId, 'file_read', `Reading ${path}`, timestamp, { file: path });
  }
  return build(id, contextId, 'tool_call', knownToolName ? `Running ${knownToolName}` : safeJson(input), timestamp);
}

/**
 * `session.tool.success` — note well (see SPIKE-FINDINGS.md, verified
 * empirically): a non-zero `data.metadata.exit` here is NOT a failure. The
 * shell tool "succeeds" at running the command and capturing its output
 * even when that command's own exit code is non-zero; the model narrates
 * the exit code as ordinary text (e.g. "Command exited with code 3.",
 * already present in `data.content[]`). This mapper therefore never
 * inspects `exit`/`status` at all — doing so to synthesize an 'error' event
 * would be a false failure. `metadata.exit`/`metadata.status` are also not
 * in `sanitizeMetadata`'s downstream whitelist (file, fileEventType,
 * language, command, diff, agentType, duration, error,
 * clarification_request, clarification_answer), so carrying them through
 * would be dropped by the worker anyway — not invented here.
 */
function mapToolSuccess(id: string, contextId: string, timestamp: number, data: Record<string, unknown> | undefined): CoreEvent | null {
  const content = textFromContentArray(data?.content) ?? '';
  const files = asArray(asRecord(data?.metadata)?.files);
  const metadata: Record<string, unknown> = {};
  if (files) {
    const fileNames: string[] = [];
    const patches: string[] = [];
    for (const entry of files) {
      const record = asRecord(entry);
      const fileName = asString(record?.file);
      const patch = asString(record?.patch);
      if (fileName) fileNames.push(fileName);
      if (patch) patches.push(patch);
    }
    if (fileNames.length > 0) metadata.file = fileNames.join(', ');
    if (patches.length > 0) metadata.diff = patches.join('\n');
  }
  return build(id, contextId, 'command_output', content, timestamp, metadata);
}

/**
 * `session.tool.failed` — the genuinely-failing-tool-call shape (VERIFIED
 * name; NOT `session.tool.error` as originally hypothesized — see
 * SPIKE-FINDINGS.md). Fires both for ordinary in-tool errors
 * (`error.type: "tool.execution"`, non-fatal to the turn) and for
 * user-declined/aborted calls (`error.type: "aborted"`, which the turn
 * follows with `session.execution.interrupted`) — this mapper does not need
 * to distinguish the two `error.type` values itself; that distinction is
 * `classifyV2Terminal`'s job on the *following* execution event, not this
 * one's.
 */
function mapToolFailed(id: string, contextId: string, timestamp: number, data: Record<string, unknown> | undefined): CoreEvent | null {
  const message = asString(asRecord(data?.error)?.message) ?? 'Tool call failed';
  return build(id, contextId, 'error', message, timestamp);
}

/**
 * `form.created` — a pending question the turn is stalled on (see
 * SPIKE-FINDINGS.md's "mechanisms that can hang a headless client forever").
 * Mapped to a 'command'-typed event carrying `metadata.clarification_request`,
 * mirroring the existing convention in
 * packages/server/src/services/test-clarification-provider.ts. The real
 * form id lives at `data.form.id` (NOT `data.id` — that nested shape is
 * `form.replied`/`form.cancelled`'s, which this mapper does not handle; see
 * classifyV2InputRequest for the id extraction contract).
 */
function mapFormCreated(id: string, contextId: string, timestamp: number, data: Record<string, unknown> | undefined): CoreEvent | null {
  const form = asRecord(data?.form);
  const formID = asString(form?.id);
  if (!formID) return null;

  const fields = asArray(form?.fields) ?? [];
  const firstField = asRecord(fields[0]);
  const title = asString(form?.title) ?? 'Question';
  const description = asString(firstField?.description) ?? asString(firstField?.title) ?? title;
  const options = asArray(firstField?.options) ?? [];
  const choices = options
    .map((option) => asString(asRecord(option)?.value))
    .filter((value): value is string => typeof value === 'string' && value !== 'Type your own answer');

  const clarification_request = {
    requestId: formID,
    prompt: description,
    ...(choices.length > 0 ? { choices } : {}),
    timestamp,
  };
  return build(id, contextId, 'command', `${title}: ${description}`, timestamp, { clarification_request });
}

/**
 * `permission.asked` — the OTHER hang source (see SPIKE-FINDINGS.md): a
 * distinct mechanism from forms, with its own reply shape
 * (`{decision:"once"|"always"|"reject"}` vs a form's `{answer:{...}}`). The
 * request id is `data.id` here (contrast `form.created`, where the
 * equivalent id is nested one level down at `data.form.id` — the two events
 * do not share a field-naming convention).
 */
function mapPermissionAsked(id: string, contextId: string, timestamp: number, data: Record<string, unknown> | undefined): CoreEvent | null {
  const requestID = asString(data?.id);
  if (!requestID) return null;

  const action = asString(data?.action) ?? 'unknown action';
  const resources = (asArray(data?.resources) ?? []).filter((r): r is string => typeof r === 'string');
  const prompt = resources.length > 0 ? `Permission requested: ${action} (${resources.join(', ')})` : `Permission requested: ${action}`;

  const clarification_request = {
    requestId: requestID,
    prompt,
    choices: ['once', 'always', 'reject'],
    timestamp,
  };
  return build(id, contextId, 'command', prompt, timestamp, { clarification_request });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Maps one raw opencode v2 SSE event to a `CoreEvent`, or `null` if it
 * should be dropped (lifecycle/telemetry noise, a resolved-elsewhere
 * human-input reply, or an event type this mapper does not (yet)
 * recognise).
 *
 * ## Delta-vs-`.ended` dedup strategy
 * v2 streams both incremental text (`session.text.delta` /
 * `session.reasoning.delta`, one per chunk) AND a terminal `.ended` event
 * that repeats the FULL accumulated text for the same
 * `assistantMessageID`+`ordinal` block. Emitting both would duplicate every
 * word the model ever streamed. This mapper always emits on `.delta` (real
 * time output, matches how a human would actually watch a stream) and
 * unconditionally drops `.text.ended` / `.reasoning.ended` / `.text.started`
 * / `.reasoning.started` — the `.ended` text is not new information, it is
 * exactly `deltas.join('')` for that block. The trade-off (documented, not
 * hidden): a hypothetical future event stream that emits a text block with
 * ZERO delta chunks and only a `.ended` would silently lose that block's
 * text under this mapper. Every fixture captured in this spike (including
 * `events2.ndjson`'s single-word "DONE" reply) always emits at least one
 * `.delta` before `.ended`, so this has not been observed in practice.
 *
 * ## Security — never leak the host workspace path
 * Every v2 event carries `location.directory`, the session's absolute host
 * path. This mapper NEVER reads `raw.location` at all, and every branch
 * below builds its `CoreEvent` from an explicit field whitelist (via the
 * `build()` helper) rather than spreading `raw`/`raw.data` — see
 * packages/worker/src/local-runner.ts's `sanitizeLocalText`/
 * `sanitizeMetadata`, which only scrub `content` and a handful of known
 * metadata string fields, NOT arbitrary passed-through envelope data.
 *
 * ## Never throws
 * Every field access below goes through `asRecord`/`asString`/`asArray`,
 * which resolve to `undefined` instead of throwing on the wrong shape, and
 * the whole function body is additionally wrapped in a top-level
 * try/catch as a backstop — an unrecognised or malformed event (including
 * one with no `data` at all) resolves to `null`, never an exception.
 *
 * ## Optional tool-name correlation
 * `toolNames`, when supplied, is consulted only for `session.tool.called`
 * (see `mapToolCalled`'s doc comment) to improve its generic fallback
 * branch. It is entirely optional and stateless from this function's own
 * point of view — building and maintaining the map across a stream is the
 * caller's responsibility (see `createV2Adapter`'s `toolCallNames`); every
 * existing single-argument call site (including every test in this file)
 * continues to work unchanged.
 */
export function mapV2Event(raw: V2RawEvent, toolNames?: ReadonlyMap<string, string>): CoreEvent | null {
  try {
    const type = typeof raw?.type === 'string' ? raw.type : undefined;
    if (!type) return null;

    const data = asRecord(raw.data);
    const contextId = sessionIdOf(raw, data);
    const id = asString(raw.id) || randomUUID();
    const timestamp = typeof raw.created === 'number' && Number.isFinite(raw.created) ? raw.created : Date.now();

    switch (type) {
      case 'session.text.delta': {
        const delta = asString(data?.delta);
        if (delta === undefined) return null;
        return build(id, contextId, 'output', delta, timestamp);
      }
      case 'session.reasoning.delta': {
        const delta = asString(data?.delta);
        if (delta === undefined) return null;
        return build(id, contextId, 'thinking', delta, timestamp);
      }
      case 'session.tool.input.started': {
        const name = asString(data?.name) ?? 'tool';
        return build(id, contextId, 'tool_call', `Starting ${name}`, timestamp);
      }
      case 'session.tool.called': {
        const callId = asString(data?.id);
        const knownToolName = callId ? toolNames?.get(callId) : undefined;
        return mapToolCalled(id, contextId, timestamp, data, knownToolName);
      }
      case 'session.tool.success':
        return mapToolSuccess(id, contextId, timestamp, data);
      case 'session.tool.failed':
        return mapToolFailed(id, contextId, timestamp, data);
      case 'form.created':
        return mapFormCreated(id, contextId, timestamp, data);
      case 'permission.asked':
        return mapPermissionAsked(id, contextId, timestamp, data);

      // Dropped deliberately (see the per-category rationale in this
      // module's spec/report, not just "unrecognised"):
      //  - session.text.started / .ended, session.reasoning.started / .ended:
      //    superseded by the .delta dedup strategy above.
      //  - session.tool.input.ended: carries the same args as
      //    session.tool.called but JSON-stringified rather than parsed;
      //    .called is preferred and this is pure duplication.
      //  - session.tool.progress: shell-id bookkeeping only, no
      //    user-visible content.
      //  - session.step.started / .ended / .failed: step-level
      //    bookkeeping (token counts, cost, finish reason) — metadata-only,
      //    not user-visible output. Step-level *failure* is not surfaced
      //    here because the same information always also arrives via the
      //    tool-level session.tool.failed AND the turn-level
      //    session.execution.failed/interrupted (see classifyV2Terminal) —
      //    surfacing it a third time here would be redundant, not new
      //    signal.
      //  - session.execution.started / .succeeded / .failed / .interrupted:
      //    turn lifecycle — surfaced via classifyV2Terminal, not as a
      //    content event.
      //  - form.replied / form.cancelled / permission.replied: resolution
      //    events for a form/permission this mapper already surfaced (as a
      //    'command' clarification event) when it was first asked. The
      //    *answer itself* is caller-supplied (the caller is the one
      //    calling the reply/decision HTTP endpoint), not new information
      //    arriving from the SSE stream, so there is nothing additional to
      //    emit here.
      //  - shell.created / shell.exited / shell.deleted: low-value shell
      //    process bookkeeping AND (see shell.created's `data.info.cwd`)
      //    the one place besides `location.directory` that also carries an
      //    absolute host path. Dropping these entirely — rather than
      //    emitting the "optional low-value output" the task's mapping
      //    table allows — is the simplest way to guarantee zero path-leak
      //    surface for this event family; the same information (command
      //    ran, exit code) is already narrated in session.tool.success's
      //    `content[]` text.
      //  - session.instructions.updated, skill.updated,
      //    session.usage.updated, server.connected, provider.updated,
      //    model.updated, mcp.status.changed, mcp.resources.changed,
      //    session.inbox.*, agent.updated, command.updated,
      //    integration.updated, plugin.updated, reference.updated,
      //    vcs.branch.updated, websearch.updated, provider.auth,
      //    session.created: server/session telemetry, not agent output.
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Classifies a raw v2 event as one of the three turn-terminal signals, or
 * `null` if it is not a terminal event at all. VERIFIED (see
 * SPIKE-FINDINGS.md): these three are the only turn-terminal SSE event
 * types in v2; `GET /api/session/{id}.outcome` is NOT a reliable
 * alternative (it is left unpopulated for `reason:"shutdown"` interrupts),
 * so SSE remains the sole authoritative signal a caller should await.
 */
export function classifyV2Terminal(raw: V2RawEvent): 'succeeded' | 'failed' | 'interrupted' | null {
  try {
    switch (raw?.type) {
      case 'session.execution.succeeded':
        return 'succeeded';
      case 'session.execution.failed':
        return 'failed';
      case 'session.execution.interrupted':
        return 'interrupted';
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Detects the two distinct "waiting on a human" mechanisms v2 exposes
 * (VERIFIED, see SPIKE-FINDINGS.md's "Every mechanism that can hang a
 * headless client forever"): forms (`form.created`) and interactive
 * permission asks (`permission.asked`). Both are top-level event types —
 * NOT namespaced as `session.form.*` / `session.permission.*` as originally
 * hypothesized (zero occurrences of that shape across every captured
 * fixture). Neither is accompanied by any `session.execution.*` terminal
 * event while pending — a caller must watch for these two event types
 * itself and apply its own timeout/defensive-unstick policy; this function
 * only detects the request, it does not answer it.
 *
 * Id field names (empirically confirmed, not assumed): a form's id is
 * `data.form.id` (nested — `data` is the whole `Form.Info` object); a
 * permission ask's id is `data.id` directly (flat).
 */
export function classifyV2InputRequest(raw: V2RawEvent): InputRequest | null {
  try {
    if (raw?.type === 'form.created') {
      const form = asRecord(asRecord(raw.data)?.form);
      const formID = asString(form?.id);
      return formID ? { kind: 'form', formID } : null;
    }
    if (raw?.type === 'permission.asked') {
      const requestID = asString(asRecord(raw.data)?.id);
      return requestID ? { kind: 'permission', requestID } : null;
    }
    return null;
  } catch {
    return null;
  }
}
