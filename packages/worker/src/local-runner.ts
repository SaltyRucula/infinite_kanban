import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import type { AgentEvent, AgentEventType, WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';

export type AgentSdkRunnerProfile = { readonly kind: 'agent-sdk' };
export type OpenCodeRunnerProfile = { readonly kind: 'opencode-run'; readonly agent: string };
export type RunnerProfile = AgentSdkRunnerProfile | OpenCodeRunnerProfile;
export type WorkspaceSettings = { readonly workspacePath: string; readonly runner: RunnerProfile };
export type OpenCodeRunResult = {
  readonly status: 'complete' | 'failed';
  readonly summary?: string;
  readonly error?: string;
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

type RunOpenCodeTaskInput = {
  readonly task: WorkerTaskAssignment;
  readonly workspacePath: string;
  readonly runner: OpenCodeRunnerProfile;
  readonly sendEvent: (event: AgentEvent) => Promise<void>;
  readonly spawnFn?: OpenCodeSpawn;
  readonly abortSignal?: AbortSignal;
};

const VALID_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set([
  'thinking',
  'tool_call',
  'file_read',
  'file_write',
  'file_edit',
  'command',
  'command_output',
  'output',
  'test_result',
  'error',
  'complete',
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function isValidEventType(value: string): value is AgentEventType {
  return VALID_EVENT_TYPES.has(value as AgentEventType);
}

function sanitizeLocalText(content: string, workspacePath: string): string {
  return content.replaceAll(workspacePath, '[local workspace]');
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

function eventFromJsonLine(taskId: string, workspacePath: string, line: string): AgentEvent {
  const parsed = asRecord(JSON.parse(line));
  if (!parsed) throw new Error('json event must be an object');

  const candidateType = asString(parsed.type);
  const type: AgentEventType = candidateType && isValidEventType(candidateType) ? candidateType : 'output';
  const contentSource = asString(parsed.content)
    ?? asString(parsed.message)
    ?? asString(parsed.text)
    ?? JSON.stringify(parsed);
  const content = sanitizeLocalText(contentSource, workspacePath);

  return {
    id: asString(parsed.id) ?? uuid(),
    taskId,
    type,
    content,
    timestamp: asTimestamp(parsed.timestamp),
  };
}

function eventFromPlainLine(taskId: string, workspacePath: string, line: string): AgentEvent {
  return {
    id: uuid(),
    taskId,
    type: 'output',
    content: sanitizeLocalText(line, workspacePath),
    timestamp: Date.now(),
  };
}

function createLineConsumer(onLine: (line: string) => void): {
  readonly push: (chunk: string) => void;
  readonly flush: () => void;
} {
  let buffered = '';
  return {
    push: (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/u);
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) onLine(line);
      }
    },
    flush: () => {
      if (buffered.trim()) {
        onLine(buffered);
      }
      buffered = '';
    },
  };
}

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio): OpenCodeProcess {
  return spawn(command, [...args], options);
}

export function parseWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const record = asRecord(raw);
  const workspacePath = asString(record?.workspacePath)?.trim();
  if (!workspacePath) {
    throw new Error('worker workspace configuration must include workspacePath');
  }

  const rawRunner = record?.runner;
  if (rawRunner === undefined) {
    return { workspacePath, runner: { kind: 'agent-sdk' } };
  }

  const runnerRecord = asRecord(rawRunner);
  const kind = asString(runnerRecord?.kind);
  if (kind === 'agent-sdk') {
    return { workspacePath, runner: { kind: 'agent-sdk' } };
  }
  if (kind === 'opencode-run') {
    const agent = asString(runnerRecord?.agent)?.trim();
    if (!agent) {
      throw new Error('runner.agent must be a non-empty string when runner.kind is opencode-run');
    }
    return { workspacePath, runner: { kind: 'opencode-run', agent } };
  }
  throw new Error('runner.kind must be either "agent-sdk" or "opencode-run"');
}

export async function runOpenCodeTask(input: RunOpenCodeTaskInput): Promise<OpenCodeRunResult> {
  const spawnFn = input.spawnFn ?? defaultSpawn;
  const runnerName = input.runner.agent.length > 0
    ? `${input.runner.agent[0].toUpperCase()}${input.runner.agent.slice(1)}`
    : input.runner.agent;
  const startEvent: AgentEvent = {
    id: uuid(),
    taskId: input.task.id,
    type: 'thinking',
    content: `Starting local ${runnerName} runner…`,
    timestamp: Date.now(),
  };
  void input.sendEvent(startEvent).catch((error: unknown) => {
    console.error(`[worker] event upload failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  const args: readonly string[] = [
    'run',
    '--agent',
    input.runner.agent,
    '--format',
    'json',
    '--dir',
    input.workspacePath,
    buildTaskPrompt(input.task),
  ];
  const child = spawnFn('opencode', args, { shell: false });

  const stderrLines: string[] = [];
  let emittedEvents = 0;
  let summary = '';
  let wasCancelled = false;

  const onStdout = createLineConsumer((line) => {
    const event = (() => {
      try {
        return eventFromJsonLine(input.task.id, input.workspacePath, line);
      } catch {
        return eventFromPlainLine(input.task.id, input.workspacePath, line);
      }
    })();
    emittedEvents += 1;
    summary = event.content;
    void input.sendEvent(event).catch((error: unknown) => {
      console.error(`[worker] event upload failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  const onStderr = createLineConsumer((line) => {
    const safeLine = sanitizeLocalText(line, input.workspacePath);
    stderrLines.push(safeLine);
    if (stderrLines.length > 10) {
      stderrLines.shift();
    }
  });

  const cancel = (): void => {
    wasCancelled = true;
    child.kill('SIGTERM');
  };

  if (input.abortSignal) {
    if (input.abortSignal.aborted) cancel();
    input.abortSignal.addEventListener('abort', cancel, { once: true });
  }

  return await new Promise<OpenCodeRunResult>((resolve) => {
    const closeHandler = (code: number | null, signal: NodeJS.Signals | null): void => {
      onStdout.flush();
      onStderr.flush();
      child.stdout.off('data', stdoutHandler);
      child.stderr.off('data', stderrHandler);
      child.off('close', closeHandler);
      child.off('error', errorHandler);
      if (input.abortSignal) {
        input.abortSignal.removeEventListener('abort', cancel);
      }
      if (wasCancelled || signal) {
        resolve({ status: 'failed', error: 'local runner cancelled', summary: 'Cancelled local runner task' });
        return;
      }
      if (code === 0) {
        const completeSummary = summary || `OpenCode run completed (${emittedEvents} events)`;
        resolve({ status: 'complete', summary: completeSummary });
        return;
      }
      const baseError = `opencode exited with code ${code ?? 'unknown'}`;
      const detail = stderrLines.length > 0 ? `${baseError}: ${stderrLines.join(' | ')}` : baseError;
      resolve({ status: 'failed', error: detail, summary: 'Local runner execution failed' });
    };

    const errorHandler = (error: Error): void => {
      onStdout.flush();
      onStderr.flush();
      child.stdout.off('data', stdoutHandler);
      child.stderr.off('data', stderrHandler);
      child.off('close', closeHandler);
      child.off('error', errorHandler);
      if (input.abortSignal) {
        input.abortSignal.removeEventListener('abort', cancel);
      }
      resolve({
        status: 'failed',
        error: sanitizeLocalText(error.message, input.workspacePath),
        summary: 'Local runner process error',
      });
    };

    const stdoutHandler = (chunk: string | Buffer): void => {
      onStdout.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    };

    const stderrHandler = (chunk: string | Buffer): void => {
      onStderr.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    };

    child.stdout.on('data', stdoutHandler);
    child.stderr.on('data', stderrHandler);
    child.on('close', closeHandler);
    child.on('error', errorHandler);
  });
}
