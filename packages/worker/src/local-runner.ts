import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import { mapOpenCodeEvent, type AgentEvent as CoreEvent } from '@codewithdan/agent-sdk-core';
import { createOpencodeClient } from '@opencode-ai/sdk';
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk';
import type { AgentEvent, WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';

export type AgentSdkRunnerProfile = { readonly kind: 'agent-sdk' };
export type OpenCodeServerRunnerProfile = { readonly kind: 'opencode-server'; readonly agent: string };
export type RunnerProfile = AgentSdkRunnerProfile | OpenCodeServerRunnerProfile;
export type WorkspaceSettings = { readonly workspacePath: string; readonly runner: RunnerProfile };
export type OpenCodeRunResult = {
  readonly status: 'complete' | 'failed';
  readonly summary?: string;
  readonly error?: string;
};

export type LiveOpenCodeServerTask = {
  readonly sessionId: string;
  readonly baseUrl: string;
  readonly done: Promise<OpenCodeRunResult>;
  sendMessage(message: string, attachmentIds?: readonly string[]): Promise<void>;
  abort(): Promise<void>;
  shutdown(): Promise<void>;
};

export interface OpenCodeProcess {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type OpenCodeSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => OpenCodeProcess;

export type OpenCodePromptBody = {
  agent?: string;
  system?: string;
  model?: { providerID: string; modelID: string };
  tools?: Readonly<Record<string, boolean>>;
  parts: readonly [{ type: 'text'; text: string }];
};

export interface OpenCodeClientLike {
  readonly session: {
    create(input: { body?: { title?: string } }): Promise<{ data?: { id: string } }>;
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

export type CreateOpenCodeClient = (input: {
  readonly baseUrl: string;
  readonly directory: string;
}) => OpenCodeClientLike;

type StartOpenCodeServerTaskInput = {
  readonly task: WorkerTaskAssignment;
  readonly workspacePath: string;
  readonly runner: OpenCodeServerRunnerProfile;
  readonly sendEvent: (event: AgentEvent) => Promise<void>;
  readonly spawnFn?: OpenCodeSpawn;
  readonly createClient?: CreateOpenCodeClient;
  readonly baseUrl?: string;
  readonly managedServer?: OpenCodeProcess;
};

const DEFAULT_SERVER_HOSTNAME = '127.0.0.1';
const DEFAULT_SERVER_PORT = 0;
const SESSION_ERROR_GRACE_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function sanitizeLocalText(content: string, workspacePath: string): string {
  return content.replaceAll(workspacePath, '[local workspace]');
}

function sanitizeMetadata(
  metadata: CoreEvent['metadata'] | undefined,
  workspacePath: string,
): AgentEvent['metadata'] | undefined {
  type WorkerMetadata = NonNullable<AgentEvent['metadata']>;
  const record = asRecord(metadata);
  if (!record) return undefined;
  const result: WorkerMetadata = {};
  if (typeof record.file === 'string') result.file = sanitizeLocalText(record.file, workspacePath);
  if (typeof record.fileEventType === 'string') result.fileEventType = record.fileEventType;
  if (typeof record.language === 'string') result.language = record.language;
  if (typeof record.command === 'string') result.command = sanitizeLocalText(record.command, workspacePath);
  if (typeof record.diff === 'string') result.diff = sanitizeLocalText(record.diff, workspacePath);
  if (typeof record.agentType === 'string') result.agentType = record.agentType as WorkerMetadata['agentType'];
  if (typeof record.duration === 'number' && Number.isFinite(record.duration)) result.duration = record.duration;
  if (typeof record.error === 'string') result.error = sanitizeLocalText(record.error, workspacePath);
  if (record.clarification_request) {
    result.clarification_request = record.clarification_request as WorkerMetadata['clarification_request'];
  }
  if (record.clarification_answer) {
    result.clarification_answer = record.clarification_answer as WorkerMetadata['clarification_answer'];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mapCoreEvent(taskId: string, workspacePath: string, event: CoreEvent): AgentEvent {
  const metadata = sanitizeMetadata(event.metadata, workspacePath);
  return {
    id: event.id || uuid(),
    taskId,
    type: event.type,
    content: sanitizeLocalText(event.content, workspacePath),
    timestamp: event.timestamp,
    ...(metadata ? { metadata } : {}),
  };
}

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio): OpenCodeProcess {
  return spawn(command, [...args], options);
}

function defaultCreateClient(input: { readonly baseUrl: string; readonly directory: string }): OpenCodeClientLike {
  return createOpencodeClient({ baseUrl: input.baseUrl, directory: input.directory }) as unknown as OpenCodeClientLike;
}

function waitForManagedServerReady(process: OpenCodeProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting for opencode serve to report a listening URL after 5000ms'));
    }, 5_000);
    let output = '';

    const onOutput = (chunk: string | Buffer): void => {
      output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const match = output.match(/opencode server listening on\s+(https?:\/\/[^\s]+)/);
      if (!match) return;
      cleanup();
      resolve(match[1]);
    };

    const onClose = (code: number | null): void => {
      cleanup();
      reject(new Error(`opencode serve exited before startup with code ${code ?? 'unknown'}`));
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const cleanup = (): void => {
      clearTimeout(timeoutId);
      process.stdout.off('data', onOutput);
      process.stderr.off('data', onOutput);
      process.off('close', onClose);
      process.off('error', onError);
    };

    process.stdout.on('data', onOutput);
    process.stderr.on('data', onOutput);
    process.on('close', onClose);
    process.on('error', onError);
  });
}

// The native `question` tool is a TUI-only interactive feature: when invoked
// headlessly there is nothing to answer it (the OpenCode server SDK exposes no
// "respond to this tool call" endpoint), so the tool call just hangs until the
// HTTP request client-side times out, surfacing as an opaque "fetch failed"
// failure with no real work done. Disable it for headless worker runs and
// instruct the agent to ask via plain text instead, so a missing-information
// case completes quickly and visibly rather than hanging/failing.
const HEADLESS_DISABLED_TOOLS: Readonly<Record<string, boolean>> = { question: false };

const HEADLESS_CLARIFICATION_SYSTEM_PROMPT = [
  'You are running headlessly with no interactive user available during this turn.',
  'The `question` tool is disabled and cannot be used — do not attempt to call it.',
  'Your workspace root may contain multiple sibling repositories. Identify which repository',
  'this task targets (match the task title/description against the directory names under your',
  'root), then work inside that repository. If no repository under your root matches this task,',
  'do NOT guess — stop and end your response clearly stating which repository you expected and',
  'that it is not present, so a human can route the task to a worker that has it.',
  'If you are blocked by a genuinely unknown requirement and cannot safely proceed,',
  'do NOT guess and do NOT keep working. Instead, stop and end your response with a clear,',
  'specific question describing exactly what you need to know to continue. Do not mark the',
  'task as done in that case — a human will read your question and follow up.',
].join(' ');

// OpenCode gates file access outside the session root behind an interactive
// `external_directory` permission prompt (and can also gate edit/bash). A
// headless worker has nobody to answer these, so the session silently blocks
// until the HTTP client times out — the true cause of the "stalls" we chased.
// Inject a non-interactive permission ruleset via OPENCODE_PERMISSION (parsed
// by `opencode serve` into its permission config) so the session never waits
// on a prompt. The session root is set to the worker's configured workspace,
// so legitimate repo work is in-bounds; "allow" here only guarantees liveness
// for the rare out-of-root access instead of an indefinite hang.
const HEADLESS_PERMISSION_ENV = JSON.stringify({
  edit: 'allow',
  bash: 'allow',
  webfetch: 'allow',
  external_directory: 'allow',
});

// Defaults to a GitHub Copilot model (requires `gh`/`copilot` CLI auth on this
// worker's host) instead of OpenCode's bundled free-tier models, which this
// worker's OpenCode CLI version is too old to use. Override via env var if a
// different provider/model should be used.
function headlessModel(): { providerID: string; modelID: string } | undefined {
  const raw = process.env.OPENCODE_WORKER_MODEL?.trim();
  const [providerID, modelID] = (raw || 'github-copilot/claude-sonnet-5').split('/');
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID };
}

const STALL_TIMEOUT_MS = 60_000;
const STALL_CHECK_INTERVAL_MS = 2_000;
const MAX_STALL_RETRIES = 2;

const STALL_RETRY_NUDGE =
  'The previous step appears to have stalled (a tool call did not report completion). '
  + 'This is a known infrastructure glitch, not something you did wrong — the tool likely '
  + 'ran fine but its result was never delivered back to you. Do not repeat the exact same '
  + 'command; instead pick up from what you already know from this conversation and continue '
  + 'toward completing the task.';

export function buildTaskPrompt(task: WorkerTaskAssignment): string {
  const labels = task.labels.length > 0 ? task.labels.join(', ') : '(none)';
  return [
    `Task title: ${task.title}`,
    '',
    `Task description: ${task.description}`,
    '',
    `Labels: ${labels}`,
  ].join('\n');
}

export function parseWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const record = asRecord(raw);
  const workspacePath = typeof record?.workspacePath === 'string' ? record.workspacePath.trim() : '';
  if (!workspacePath) {
    throw new Error('worker workspace configuration must include workspacePath');
  }

  const rawRunner = record?.runner;
  if (rawRunner === undefined) {
    return { workspacePath, runner: { kind: 'agent-sdk' } };
  }

  const runnerRecord = asRecord(rawRunner);
  const kind = typeof runnerRecord?.kind === 'string' ? runnerRecord.kind : '';
  if (kind === 'agent-sdk') {
    return { workspacePath, runner: { kind: 'agent-sdk' } };
  }
  if (kind === 'opencode-server') {
    const agent = typeof runnerRecord?.agent === 'string' ? runnerRecord.agent.trim() : '';
    if (!agent) {
      throw new Error('runner.agent must be a non-empty string when runner.kind is opencode-server');
    }
    return { workspacePath, runner: { kind: 'opencode-server', agent } };
  }
  throw new Error('runner.kind must be either "agent-sdk" or "opencode-server"');
}

export async function startOpenCodeServerTask(input: StartOpenCodeServerTaskInput): Promise<LiveOpenCodeServerTask> {
  const spawnFn = input.spawnFn ?? defaultSpawn;
  const createClient = input.createClient ?? defaultCreateClient;

  const managedServer = input.managedServer ?? (!input.baseUrl
    ? spawnFn('opencode', ['serve', `--hostname=${DEFAULT_SERVER_HOSTNAME}`, `--port=${DEFAULT_SERVER_PORT}`], {
        shell: false,
        env: { ...process.env, OPENCODE_PERMISSION: HEADLESS_PERMISSION_ENV },
      })
    : undefined);
  if (input.baseUrl) {
    return startOpenCodeServerTaskWithClient({ ...input, baseUrl: input.baseUrl, managedServer, createClient });
  }
  if (!managedServer) {
    throw new Error('failed to start managed opencode server');
  }
  const baseUrl = await waitForManagedServerReady(managedServer);
  return startOpenCodeServerTaskWithClient({ ...input, baseUrl, managedServer, createClient });
}

type StartOpenCodeServerTaskWithClientInput = StartOpenCodeServerTaskInput & {
  readonly baseUrl: string;
  readonly managedServer: OpenCodeProcess | undefined;
  readonly createClient: CreateOpenCodeClient;
};

async function startOpenCodeServerTaskWithClient(input: StartOpenCodeServerTaskWithClientInput): Promise<LiveOpenCodeServerTask> {
  const client = input.createClient({ baseUrl: input.baseUrl, directory: input.workspacePath });

  const created = await client.session.create({ body: { title: input.task.title } });
  const sessionId = created.data?.id;
  if (!sessionId) {
    throw new Error('opencode session create returned no session id');
  }

  // `prompt()` can resolve without throwing even when the server failed
  // internally (observed: a `createUserMessage` exception never surfaced as
  // an HTTP error), so a successful `prompt()` alone cannot prove the turn
  // ran; the SSE `session.error` event is the reliable signal, tracked here.
  let sessionErrorMessage: string | undefined;
  let resolveSessionError: (message: string) => void = () => {};
  const sessionErrorSignal = new Promise<string>((resolve) => { resolveSessionError = resolve; });

  // Tool calls occasionally never report completion back through the SSE
  // stream (observed independent of CPU load or command complexity — e.g. a
  // `find` that runs in under a second locally still leaves the session
  // "running" indefinitely). `client.session.prompt()` then blocks until the
  // outer HTTP client times out (~5 minutes) with a generic "fetch failed".
  // Track the last time *any* event arrived so a stall can be detected and
  // retried well before that outer timeout, instead of just failing.
  let lastActivityAt = Date.now();

  const streamAbortController = new AbortController();
  let aborted = false;
  const streamLoop = (async (): Promise<void> => {
    try {
      const streamResult = await client.event.subscribe({ signal: streamAbortController.signal, sseMaxRetryAttempts: 0 });
      for await (const event of streamResult.stream) {
        mapOpenCodeEvent(sessionId, event, input.task.id, (coreEvent: CoreEvent) => {
          lastActivityAt = Date.now();
          const mapped = mapCoreEvent(input.task.id, input.workspacePath, coreEvent);
          if (mapped.type === 'error' && sessionErrorMessage === undefined) {
            sessionErrorMessage = mapped.content || 'opencode session reported an error';
            resolveSessionError(sessionErrorMessage);
          }
          void input.sendEvent(mapped).catch((error: unknown) => {
            console.error(`[worker] event upload failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        });
      }
    } catch {
      return;
    }
  })();

  const abort = async (): Promise<void> => {
    aborted = true;
    streamAbortController.abort();
    await client.session.abort({ path: { id: sessionId } });
  };

  const shutdown = async (): Promise<void> => {
    aborted = true;
    streamAbortController.abort();
    await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
    input.managedServer?.kill('SIGTERM');
  };

  const promptWithStallRecovery = async (body: OpenCodePromptBody): Promise<void> => {
    let attempt = 0;
    let currentBody = body;
    for (;;) {
      lastActivityAt = Date.now();
      const promptPromise = client.session.prompt({ path: { id: sessionId }, body: currentBody });
      let stallTimer: ReturnType<typeof setInterval> | undefined;
      const stallPromise = new Promise<'stalled'>((resolve) => {
        stallTimer = setInterval(() => {
          if (Date.now() - lastActivityAt > STALL_TIMEOUT_MS) resolve('stalled');
        }, STALL_CHECK_INTERVAL_MS);
      });
      const outcome = await Promise.race([promptPromise.then(() => 'done' as const), stallPromise]);
      clearInterval(stallTimer);
      if (outcome === 'done') return;

      // Stalled: the original prompt() call is still in flight server-side,
      // but we've given up waiting on it. Swallow whatever it eventually
      // settles with (we've already moved on) so it doesn't surface as an
      // unhandled rejection, then abort the turn and retry with a nudge.
      void promptPromise.catch(() => undefined);
      attempt += 1;
      await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
      if (attempt > MAX_STALL_RETRIES) {
        throw new Error(`OpenCode session stalled with no tool-call progress for over ${STALL_TIMEOUT_MS / 1000}s, even after ${MAX_STALL_RETRIES} retries`);
      }
      currentBody = { ...currentBody, parts: [{ type: 'text', text: STALL_RETRY_NUDGE }] };
    }
  };

  const done = (async (): Promise<OpenCodeRunResult> => {
    try {
      await promptWithStallRecovery({
        agent: input.runner.agent,
        system: HEADLESS_CLARIFICATION_SYSTEM_PROMPT,
        model: headlessModel(),
        tools: HEADLESS_DISABLED_TOOLS,
        parts: [{ type: 'text', text: buildTaskPrompt(input.task) }],
      });
      if (aborted) {
        return { status: 'failed', error: 'opencode session cancelled', summary: 'Cancelled OpenCode session task' };
      }
      // The SSE stream can lag the HTTP response by a beat; race a bounded
      // grace period against sessionErrorSignal so a late `session.error`
      // still overrides a falsely-successful `prompt()` resolution.
      const late = await Promise.race([
        sessionErrorSignal.then((message) => ({ message })),
        sleep(SESSION_ERROR_GRACE_MS).then(() => undefined),
      ]);
      if (late) {
        return { status: 'failed', error: late.message, summary: 'OpenCode server task failed' };
      }
      return { status: 'complete', summary: 'OpenCode server task completed' };
    } catch (error: unknown) {
      const message = sanitizeLocalText(error instanceof Error ? error.message : String(error), input.workspacePath);
      return { status: 'failed', error: message, summary: 'OpenCode server task failed' };
    } finally {
      streamAbortController.abort();
      await streamLoop;
    }
  })();

  return {
    sessionId,
    baseUrl: input.baseUrl,
    done,
    sendMessage: async (message: string, _attachmentIds?: readonly string[]) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      await promptWithStallRecovery({
        agent: input.runner.agent,
        model: headlessModel(),
        tools: HEADLESS_DISABLED_TOOLS,
        parts: [{ type: 'text', text: trimmed }],
      });
    },
    abort,
    shutdown,
  };
}
