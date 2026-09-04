import { spawn, type ChildProcess } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import { createOpencodeClient } from '@opencode-ai/sdk';
import type { SessionPromptData } from '@opencode-ai/sdk';
import { mapOpenCodeEvent } from '@codewithdan/agent-sdk-core';
import { diagnoseError, formatDiagnostic } from '@codewithdan/agent-sdk-core/providers';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentResult,
  AgentType,
} from '@codewithdan/agent-sdk-core/types';
import { isTransientNetworkError } from '../utils.js';

export interface NonDestructiveOpenCodeProviderOptions {
  model?: string;
  hostname?: string;
  port?: number;
  baseUrl?: string;
  /** Sessions kept per task title before older ones are pruned. */
  maxSessionsPerTask?: number;
}

const DEFAULT_MAX_SESSIONS_PER_TASK = 5;
const OPENCODE_RECOVERY_MAX_ATTEMPTS = 4;
const OPENCODE_RECOVERY_DEADLINE_MS = 30_000;
const OPENCODE_SESSION_PROBE_TIMEOUT_MS = 2_000;
const OPENCODE_PROMPT_RETRY_TIMEOUT_MS = 5_000;
const OPENCODE_RECOVERY_DELAYS_MS = [0, 500, 1_000, 2_000] as const;
const OPENCODE_SSE_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const OPENCODE_EVENT_DEDUP_LIMIT = 2048;

type SessionPromptRequestBody = NonNullable<SessionPromptData['body']>;
type OpenCodeEvent = Parameters<typeof mapOpenCodeEvent>[1];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getNestedRecord(root: unknown, key: string): Record<string, unknown> | null {
  if (!root || typeof root !== 'object') return null;
  const value = (root as Record<string, unknown>)[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getDedupEventKey(sessionId: string, event: OpenCodeEvent): string {
  const root = event as Record<string, unknown>;
  const directId = toStringOrNull(root.id);
  if (directId) return `id:${directId}`;

  const type = toStringOrNull(root.type) ?? 'unknown';
  const properties = getNestedRecord(root, 'properties') ?? {};
  const info = getNestedRecord(properties, 'info') ?? {};
  const part = getNestedRecord(properties, 'part') ?? {};
  const infoTime = getNestedRecord(info, 'time') ?? {};

  const subset = {
    type,
    sessionID: toStringOrNull(properties.sessionID)
      ?? toStringOrNull(info.sessionID)
      ?? sessionId,
    messageID: toStringOrNull(properties.messageID)
      ?? toStringOrNull(info.messageID)
      ?? toStringOrNull(part.messageID),
    partID: toStringOrNull(properties.partID)
      ?? toStringOrNull(part.id)
      ?? toStringOrNull(info.id),
    status: toStringOrNull(properties.status),
    timestamp: toNumberOrNull(infoTime.created)
      ?? toNumberOrNull(infoTime.completed)
      ?? toNumberOrNull(properties.timestamp),
  };

  return `fallback:${JSON.stringify(subset)}`;
}

function extractErrorMessage(error: { name: string; data?: unknown }): string {
  if (error.data && typeof error.data === 'object' && 'message' in error.data) {
    return String((error.data as { message: unknown }).message);
  }
  return error.name;
}

/**
 * OpenCode provider used by the board in place of
 * `@codewithdan/agent-sdk-core`'s `OpenCodeProvider`.
 *
 * The upstream provider's `destroy()` calls `client.session.delete()`,
 * which the board triggers on every terminal path (failure, timeout, stop,
 * completion) — permanently destroying the remote OpenCode session, so it
 * can never be reopened once a task stops. This provider closes the SSE
 * subscription on destroy but leaves the remote session intact, and prunes
 * older sessions for the same task (matched by title, capped at
 * `maxSessionsPerTask`) so history does not grow unbounded.
 */
export class NonDestructiveOpenCodeProvider implements AgentProvider {
  readonly name: AgentType = 'opencode';
  readonly displayName = 'OpenCode';
  readonly model: string;

  private client: ReturnType<typeof createOpencodeClient> | null = null;
  private managedServer: { process: ChildProcess; close(): Promise<void> } | null = null;
  private readonly sessions = new Set<AgentSession>();
  private providerID?: string;
  private modelID?: string;
  private readonly recoveryDiagnostics = new Map<string, string>();
  private readonly baseUrl?: string;
  private readonly hostname: string;
  private readonly port: number;
  private readonly maxSessionsPerTask: number;

  constructor(options?: NonDestructiveOpenCodeProviderOptions) {
    const configuredModel = options?.model || process.env.OPENCODE_MODEL;
    this.model = configuredModel || 'configured default';
    if (configuredModel) {
      const [providerID, ...rest] = configuredModel.split('/');
      this.providerID = providerID;
      this.modelID = rest.join('/');
    }
    this.baseUrl = options?.baseUrl;
    this.hostname = options?.hostname || '127.0.0.1';
    this.port = options?.port || 0;
    this.maxSessionsPerTask = options?.maxSessionsPerTask ?? DEFAULT_MAX_SESSIONS_PER_TASK;
  }

  async start(): Promise<void> {
    if (this.baseUrl) {
      this.client = createOpencodeClient({ baseUrl: this.baseUrl });
      console.log(`[opencode-provider] connected to existing server at ${this.baseUrl}`);
      return;
    }
    const server = await startManagedOpenCodeServer(this.hostname, this.port);
    this.client = createOpencodeClient({ baseUrl: server.url });
    this.managedServer = { process: server.process, close: () => stopManagedOpenCodeServer(server.process) };
    console.log(`[opencode-provider] server started at ${server.url} (model: ${this.model})`);
  }

  async stop(): Promise<void> {
    const sessions = [...this.sessions];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.destroy()));
    if (this.managedServer) {
      await this.managedServer.close();
      this.managedServer = null;
    }
    this.client = null;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    if (!this.client) {
      throw new Error('OpenCode client not initialized — call start() first');
    }
    const client = this.client;
    const model = this.providerID && this.modelID
      ? { providerID: this.providerID, modelID: this.modelID }
      : undefined;

    let sessionId: string;
    if (config.resumeSessionId) {
      try {
        const existing = await client.session.get({ path: { id: config.resumeSessionId } });
        if (!existing.data) throw new Error('Session not found');
        sessionId = existing.data.id;
      } catch {
        console.log('[opencode-provider] resume failed, creating new session');
        const created = await client.session.create({ body: { title: config.contextId } });
        if (!created.data) throw new Error('OpenCode session creation returned no data');
        sessionId = created.data.id;
      }
    } else {
      const created = await client.session.create({ body: { title: config.contextId } });
      if (!created.data) throw new Error('OpenCode session creation returned no data');
      sessionId = created.data.id;
    }

    this.pruneOldSessions(config.contextId, sessionId).catch((err: unknown) => {
      console.warn(`[opencode-provider] session pruning failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    let sseLoopDone: Promise<void> | null = null;
    let sseAbortController: AbortController | null = null;
    let destroyed = false;
    let sseGeneration = 0;
    let sseConsecutiveFailures = 0;
    const seenEventKeys = new Map<string, true>();

    const rememberEvent = (event: OpenCodeEvent): boolean => {
      const key = getDedupEventKey(sessionId, event);
      if (seenEventKeys.has(key)) return false;
      seenEventKeys.set(key, true);
      if (seenEventKeys.size > OPENCODE_EVENT_DEDUP_LIMIT) {
        const oldest = seenEventKeys.keys().next().value;
        if (oldest) seenEventKeys.delete(oldest);
      }
      return true;
    };

    const runSseLoop = async (generation: number): Promise<void> => {
      while (!destroyed && generation === sseGeneration) {
        if (sseConsecutiveFailures > 0) {
          const idx = Math.min(sseConsecutiveFailures - 1, OPENCODE_SSE_RECONNECT_DELAYS_MS.length - 1);
          await delay(OPENCODE_SSE_RECONNECT_DELAYS_MS[idx]);
        }
        if (destroyed || generation !== sseGeneration) break;

        try {
          const controller = new AbortController();
          sseAbortController = controller;
          const sse = await client.event.subscribe({ signal: controller.signal, sseMaxRetryAttempts: 0 });
          if (destroyed || generation !== sseGeneration) {
            controller.abort();
            break;
          }
          sseConsecutiveFailures = 0;

          for await (const event of sse.stream as AsyncIterable<OpenCodeEvent>) {
            if (destroyed || generation !== sseGeneration) break;
            if (!rememberEvent(event)) continue;
            mapOpenCodeEvent(sessionId, event, config.contextId, config.onEvent);
          }

          if (destroyed || generation !== sseGeneration) break;
          sseConsecutiveFailures += 1;
        } catch {
          if (destroyed || generation !== sseGeneration) break;
          sseConsecutiveFailures += 1;
        }
      }
    };

    sseLoopDone = runSseLoop(++sseGeneration);

    let isFirstPrompt = true;

    const provider = this;
    const agentSession: AgentSession = {
      get sessionId() {
        return sessionId;
      },
      async execute(prompt: string, attachments?: unknown[]): Promise<AgentResult> {
        if (attachments?.length) {
          console.warn('[opencode-provider] attachments are not supported by OpenCode — they will be ignored');
        }
        // Deliberately no messageID: this installed OpenCode server silently
        // no-ops session.prompt() whenever a caller-supplied messageID is
        // present (empirically verified — the SDK's type declares it
        // optional, but the server does not implement it safely). A retry
        // reissue below is therefore a plain reissue, not a stable-ID
        // idempotent one; see recoverPrompt().
        const promptBody: SessionPromptRequestBody = {
          ...(model ? { model } : {}),
          parts: [{ type: 'text', text: prompt }],
          ...(isFirstPrompt && config.systemPrompt ? { system: config.systemPrompt } : {}),
        };
        const deadlineAt = Date.now() + OPENCODE_RECOVERY_DEADLINE_MS;

        try {
          const result = await client.session.prompt({ path: { id: sessionId }, body: promptBody });
          isFirstPrompt = false;
          const info = result.data?.info as { error?: { name: string; data?: unknown } } | undefined;
          if (info?.error) {
            const errMsg = extractErrorMessage(info.error);
            const diag = formatDiagnostic(diagnoseError('opencode', errMsg, config.workingDirectory));
            config.onEvent({ id: uuid(), contextId: config.contextId, type: 'error', content: `OpenCode SDK error: ${diag}`, timestamp: Date.now() });
            return { status: 'failed', error: diag };
          }
          config.onEvent({ id: uuid(), contextId: config.contextId, type: 'complete', content: 'OpenCode completed the task.', timestamp: Date.now() });
          return { status: 'complete' };
        } catch (err) {
          isFirstPrompt = false;
          const message = err instanceof Error ? err.message : String(err);
          const diag = formatDiagnostic(diagnoseError('opencode', message, config.workingDirectory));
          if (isTransientNetworkError(err)) {
            provider.recoveryDiagnostics.set(sessionId, diag);
            try {
              return await provider.recoverPrompt(promptBody, sessionId, config, deadlineAt);
            } finally {
              provider.recoveryDiagnostics.delete(sessionId);
            }
          }
          config.onEvent({ id: uuid(), contextId: config.contextId, type: 'error', content: `OpenCode SDK error: ${diag}`, timestamp: Date.now() });
          return { status: 'failed', error: diag };
        }
      },
      async send(message: string, attachments?: unknown[]): Promise<void> {
        if (attachments?.length) {
          console.warn('[opencode-provider] attachments are not supported by OpenCode — they will be ignored');
        }
        try {
          await client.session.prompt({
            path: { id: sessionId },
            body: { ...(model ? { model } : {}), parts: [{ type: 'text', text: message }] },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const diag = formatDiagnostic(diagnoseError('opencode', msg, config.workingDirectory));
          config.onEvent({ id: uuid(), contextId: config.contextId, type: 'error', content: `OpenCode SDK error: ${diag}`, timestamp: Date.now() });
        }
      },
      async abort(): Promise<void> {
        try {
          await client.session.abort({ path: { id: sessionId } });
        } catch { /* ignore */ }
      },
      async destroy(): Promise<void> {
        destroyed = true;
        sseGeneration += 1;
        if (sseAbortController) {
          sseAbortController.abort();
          sseAbortController = null;
        }
        if (sseLoopDone) {
          try { await sseLoopDone; } catch { /* ignore */ }
        }
        sessions.delete(agentSession);
        // Deliberately does not call client.session.delete(): the remote
        // session must remain reachable after the task stops.
      },
    };
    this.sessions.add(agentSession);
    const sessions = this.sessions;
    return agentSession;
  }

  private async recoverPrompt(
    promptBody: SessionPromptRequestBody,
    sessionId: string,
    config: AgentSessionConfig,
    deadlineAt: number,
  ): Promise<AgentResult> {
    if (!this.client) {
      const fallback = this.recoveryDiagnostics.get(sessionId) ?? 'OpenCode client not initialized';
      config.onEvent({ id: uuid(), contextId: config.contextId, type: 'error', content: `OpenCode SDK error: ${fallback}`, timestamp: Date.now() });
      return { status: 'failed', error: fallback };
    }

    const baseDiagnostic = this.recoveryDiagnostics.get(sessionId) ?? 'OpenCode transient network failure';
    let attemptsUsed = 0;

    for (let attempt = 0; attempt < OPENCODE_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
      if (Date.now() > deadlineAt) break;
      attemptsUsed = attempt + 1;

      const delayMs = OPENCODE_RECOVERY_DELAYS_MS[Math.min(attempt, OPENCODE_RECOVERY_DELAYS_MS.length - 1)];
      if (delayMs > 0) await delay(delayMs);
      if (Date.now() > deadlineAt) break;

      let probe: Awaited<ReturnType<ReturnType<typeof createOpencodeClient>['session']['get']>>;
      try {
        probe = await withTimeout(
          this.client.session.get({ path: { id: sessionId } }),
          OPENCODE_SESSION_PROBE_TIMEOUT_MS,
          'OpenCode session probe',
        );
      } catch (probeErr) {
        if (isTransientNetworkError(probeErr)) {
          continue;
        }
        const probeMessage = probeErr instanceof Error ? probeErr.message : String(probeErr);
        const probeDiag = formatDiagnostic(diagnoseError('opencode', probeMessage, config.workingDirectory));
        config.onEvent({ id: uuid(), contextId: config.contextId, type: 'error', content: `OpenCode SDK error: ${probeDiag}`, timestamp: Date.now() });
        return { status: 'failed', error: probeDiag };
      }

      if (!probe.data) {
        const terminal = 'OpenCode session no longer exists';
        config.onEvent({ id: uuid(), contextId: config.contextId, type: 'error', content: `OpenCode SDK error: ${terminal}`, timestamp: Date.now() });
        return { status: 'failed', error: terminal };
      }

      try {
        const promptResult = await withTimeout(
          this.client.session.prompt({ path: { id: sessionId }, body: promptBody }),
          OPENCODE_PROMPT_RETRY_TIMEOUT_MS,
          'OpenCode prompt retry',
        );
        const info = promptResult.data?.info as { error?: { name: string; data?: unknown } } | undefined;
        if (info?.error) {
          const errMsg = extractErrorMessage(info.error);
          const diag = formatDiagnostic(diagnoseError('opencode', errMsg, config.workingDirectory));
          config.onEvent({ id: uuid(), contextId: config.contextId, type: 'error', content: `OpenCode SDK error: ${diag}`, timestamp: Date.now() });
          return { status: 'failed', error: diag };
        }
        config.onEvent({ id: uuid(), contextId: config.contextId, type: 'complete', content: 'OpenCode completed the task.', timestamp: Date.now() });
        return { status: 'complete' };
      } catch (retryErr) {
        if (isTransientNetworkError(retryErr)) {
          continue;
        }
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
        const retryDiag = formatDiagnostic(diagnoseError('opencode', retryMessage, config.workingDirectory));
        config.onEvent({ id: uuid(), contextId: config.contextId, type: 'error', content: `OpenCode SDK error: ${retryDiag}`, timestamp: Date.now() });
        return { status: 'failed', error: retryDiag };
      }
    }

    const exhausted = `${baseDiagnostic}, recovery exhausted after ${attemptsUsed} attempts`;
    config.onEvent({ id: uuid(), contextId: config.contextId, type: 'error', content: `OpenCode SDK error: ${exhausted}`, timestamp: Date.now() });
    return { status: 'failed', error: exhausted };
  }

  private async pruneOldSessions(title: string, currentSessionId: string): Promise<void> {
    if (!this.client) return;
    const list = await this.client.session.list();
    const olderSiblings = (list.data ?? [])
      .filter((session) => session.title === title && session.id !== currentSessionId)
      .sort((a, b) => b.time.updated - a.time.updated);
    const keptSiblingCount = this.maxSessionsPerTask - 1;
    const toDelete = olderSiblings.slice(Math.max(0, keptSiblingCount));
    for (const stale of toDelete) {
      try {
        await this.client.session.delete({ path: { id: stale.id } });
      } catch { /* best effort */ }
    }
  }
}

/**
 * Start OpenCode in its own process group so stop() can terminate both the
 * Node wrapper and the underlying .opencode child.
 */
async function startManagedOpenCodeServer(hostname: string, port: number): Promise<{ url: string; process: ChildProcess }> {
  const args = ['serve', `--hostname=${hostname}`, `--port=${port}`];
  const proc = spawn('opencode', args, { detached: true, env: process.env });
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for OpenCode server to start after 5000ms')), 5000);
    let settled = false;
    let output = '';
    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    }
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/opencode server listening on\s+(https?:\/\/[^\s]+)/);
      if (match) settle(() => resolve(match[1]));
    });
    proc.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.on('exit', (code) => settle(() => reject(new Error(`OpenCode server exited with code ${code}${output.trim() ? `\nServer output: ${output}` : ''}`))));
    proc.on('error', (error) => settle(() => reject(error)));
  });
  return { url, process: proc };
}

async function stopManagedOpenCodeServer(proc: ChildProcess): Promise<void> {
  if (!proc.killed) {
    try {
      process.kill(-(proc.pid as number), 'SIGTERM');
    } catch {
      proc.kill();
    }
  }
  await Promise.race([
    new Promise<void>((resolve) => proc.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      process.kill(-(proc.pid as number), 'SIGKILL');
    } catch {
      proc.kill('SIGKILL');
    }
  }
}
