import { createOpencodeClient } from '@opencode-ai/sdk';
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk';
import { mapOpenCodeEvent } from '@codewithdan/agent-sdk-core';
import type {
  CoreEvent,
  OpenCodeAdapter,
  PendingQuestion,
  SessionSpec,
  SessionSummary,
  TurnOpts,
  TurnResult,
} from './types.js';

/**
 * v1's per-prompt request body. Sent verbatim on every `session.prompt()`
 * call — v1 has no server-side memory of `agent`/`system`/`model`/`tools`
 * between prompts, so whatever isn't resent here is simply absent for that
 * turn.
 */
export type OpenCodePromptBody = {
  agent?: string;
  system?: string;
  model?: { providerID: string; modelID: string };
  tools?: Readonly<Record<string, boolean>>;
  parts: readonly [{ type: 'text'; text: string }];
};

/**
 * Structural shape of the real `@opencode-ai/sdk` v1 client that this
 * adapter depends on. Kept as an explicit interface (rather than importing
 * the SDK's own generated client type directly) so tests can supply a fake
 * implementation without constructing a real HTTP client — this is the same
 * seam local-runner.ts's tests used before the adapter existed, just moved
 * here since it is v1-specific.
 */
export interface OpenCodeClientLike {
  readonly session: {
    create(input: { body?: { title?: string } }): Promise<{ data?: { id: string } }>;
    get(input: { path: { id: string } }): Promise<{ data?: { id: string } | null }>;
    list(): Promise<{ data?: Array<{ id: string; title: string; time: { updated: number } }> }>;
    delete(input: { path: { id: string } }): Promise<unknown>;
    prompt(input: {
      path: { id: string };
      body?: OpenCodePromptBody;
    }): Promise<unknown>;
    abort(input: { path: { id: string } }): Promise<unknown>;
  };
  readonly event: {
    subscribe(input?: { signal?: AbortSignal; sseMaxRetryAttempts?: number }): Promise<{
      stream: AsyncGenerator<OpenCodeEvent, void, unknown>;
    }>;
  };
}

export type CreateV1AdapterInput = {
  readonly baseUrl: string;
  readonly directory: string;
  /** Injectable client (test seam). Defaults to a real `createOpencodeClient({ baseUrl, directory })`. */
  readonly client?: OpenCodeClientLike;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

// v1-specific: extracts the assistant's final text reply from a prompt()
// response's `data.parts` array. Moved here unchanged from local-runner.ts
// (formerly `responseText`), since it depends entirely on v1's prompt
// response shape.
function extractResponseText(response: unknown): string {
  const parts = asRecord(asRecord(response)?.data)?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => asRecord(part))
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part?.text as string)
    .join('\n');
}

function extractErrorMessage(error: { name: string; data?: unknown }): string {
  if (error.data && typeof error.data === 'object' && 'message' in error.data) {
    return String((error.data as { message: unknown }).message);
  }
  return error.name;
}

function defaultClient(baseUrl: string, directory: string): OpenCodeClientLike {
  return createOpencodeClient({ baseUrl, directory }) as unknown as OpenCodeClientLike;
}

/**
 * Wraps the real (or a fake, for tests) v1 `@opencode-ai/sdk` client behind
 * the `OpenCodeAdapter` contract. Behaviour is unchanged from the
 * pre-adapter code in local-runner.ts / non-destructive-provider.ts — this
 * is a pure relocation, not a rewrite of v1 semantics.
 */
export function createV1Adapter(input: CreateV1AdapterInput): OpenCodeAdapter {
  const client = input.client ?? defaultClient(input.baseUrl, input.directory);

  // Stores each session's spec so `runTurn` can fall back to it as the
  // per-turn default (see TurnOpts' doc comment for the override rules).
  // This is what "the v1 adapter simply stores the spec and re-sends it on
  // every runTurn" means in practice for v1: a convenience default for
  // callers that don't want to repeat themselves every turn. Callers that
  // need per-turn variation regardless of how the session was opened (e.g.
  // the worker resuming a session it never called createSession for) are
  // expected to pass explicit TurnOpts instead of relying on this map.
  const specs = new Map<string, SessionSpec>();

  return {
    apiVersion: 1,

    async createSession(spec: SessionSpec): Promise<string> {
      const created = await client.session.create({ body: { title: spec.title } });
      const id = created.data?.id;
      if (!id) {
        throw new Error('opencode session create returned no session id');
      }
      specs.set(id, spec);
      return id;
    },

    async getSession(id: string): Promise<string | null> {
      const existing = await client.session.get({ path: { id } });
      return existing?.data?.id ?? null;
    },

    async listSessions(): Promise<SessionSummary[]> {
      const list = await client.session.list();
      return (list.data ?? []).map((session) => ({
        id: session.id,
        title: session.title,
        updated: session.time.updated,
      }));
    },

    async deleteSession(id: string): Promise<void> {
      await client.session.delete({ path: { id } });
      specs.delete(id);
    },

    // Resolves only once the assistant turn is fully complete: v1's
    // session.prompt() call itself does not return until the server has
    // finished processing the turn (unlike v2's fire-and-forget prompt
    // endpoint — see the contract doc comment on OpenCodeAdapter.runTurn).
    async runTurn(id: string, text: string, opts: TurnOpts = {}): Promise<TurnResult> {
      const spec = specs.get(id);
      const agent = opts.agent ?? spec?.agent;
      const model = opts.model ?? spec?.model;
      const system = opts.systemPrompt === null ? undefined : (opts.systemPrompt ?? spec?.systemPrompt);
      const tools = opts.disabledTools ?? spec?.disabledTools;

      const body: OpenCodePromptBody = {
        ...(agent ? { agent } : {}),
        ...(system ? { system } : {}),
        ...(model ? { model } : {}),
        ...(tools ? { tools } : {}),
        parts: [{ type: 'text', text }],
      };

      const response = await client.session.prompt({ path: { id }, body });
      const info = asRecord(asRecord(response)?.data)?.info as { error?: { name: string; data?: unknown } } | undefined;
      const error = info?.error ? extractErrorMessage(info.error) : undefined;
      return { text: extractResponseText(response), ...(error ? { error } : {}) };
    },

    async interrupt(id: string): Promise<void> {
      await client.session.abort({ path: { id } });
    },

    subscribe(id: string, signal: AbortSignal): AsyncIterable<CoreEvent> {
      return subscribeSession(client, id, signal);
    },

    // The native `question` tool is TUI-only and is disabled entirely for
    // headless runs (see HEADLESS_DISABLED_TOOLS in the worker) — v1 has no
    // API to inspect or answer a pending tool call anyway.
    async pendingQuestions(): Promise<PendingQuestion[]> {
      return [];
    },

    async settleQuestion(): Promise<void> {
      // no-op — see pendingQuestions above.
    },
  };
}

async function* subscribeSession(
  client: OpenCodeClientLike,
  sessionId: string,
  signal: AbortSignal,
): AsyncGenerator<CoreEvent, void, unknown> {
  const { stream } = await client.event.subscribe({ signal, sseMaxRetryAttempts: 0 });
  for await (const event of stream) {
    // mapOpenCodeEvent can invoke its callback zero, one, or multiple times
    // per raw SSE event (e.g. a 'patch' event emits one core event per
    // changed file) — collect them all before yielding so no emission is
    // dropped, and yield in the same order they were produced.
    const mapped: CoreEvent[] = [];
    // contextId is set to the opencode session id here: this adapter has no
    // visibility into whatever correlation id a caller ultimately wants
    // tagged on the event (e.g. the board's task id) — callers that care
    // (as non-destructive-provider does) are expected to overwrite
    // `contextId` themselves before using the event further. Callers that
    // don't care (as local-runner does — it always uses its own closure-
    // captured task id instead of trusting event.contextId) are unaffected.
    mapOpenCodeEvent(sessionId, event, sessionId, (coreEvent) => { mapped.push(coreEvent); });
    for (const coreEvent of mapped) {
      yield coreEvent;
    }
  }
}
