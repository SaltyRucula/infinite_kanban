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

export interface OpenCodeClientLike {
  readonly session: {
    create(input: { body?: { title?: string } }): Promise<{ data?: { id: string } }>;
    prompt(input: {
      path: { id: string };
      body?: { agent?: string; parts: readonly [{ type: 'text'; text: string }] };
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
    ? spawnFn('opencode', ['serve', `--hostname=${DEFAULT_SERVER_HOSTNAME}`, `--port=${DEFAULT_SERVER_PORT}`], { shell: false })
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

  const streamAbortController = new AbortController();
  let aborted = false;
  const streamLoop = (async (): Promise<void> => {
    try {
      const streamResult = await client.event.subscribe({ signal: streamAbortController.signal, sseMaxRetryAttempts: 0 });
      for await (const event of streamResult.stream) {
        mapOpenCodeEvent(sessionId, event, input.task.id, (coreEvent: CoreEvent) => {
          const mapped = mapCoreEvent(input.task.id, input.workspacePath, coreEvent);
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

  const done = (async (): Promise<OpenCodeRunResult> => {
    try {
      await client.session.prompt({
        path: { id: sessionId },
        body: { agent: input.runner.agent, parts: [{ type: 'text', text: buildTaskPrompt(input.task) }] },
      });
      if (aborted) {
        return { status: 'failed', error: 'opencode session cancelled', summary: 'Cancelled OpenCode session task' };
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
      await client.session.prompt({
        path: { id: sessionId },
        body: { agent: input.runner.agent, parts: [{ type: 'text', text: trimmed }] },
      });
    },
    abort,
    shutdown,
  };
}
