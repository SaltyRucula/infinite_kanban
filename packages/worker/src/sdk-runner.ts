import { v4 as uuid } from 'uuid';
import {
  OpenCodeProvider,
  type AgentEvent as CoreEvent,
  type AgentProvider,
} from '@codewithdan/agent-sdk-core';
import type {
  AgentEvent,
  AgentEventType,
  AgentType,
  WorkerTaskAssignment,
} from '@ai-agent-board/shared/types.js';
import { isValidAgentType } from '@ai-agent-board/shared/constants.js';
import { buildResumeContext, extractInputRequest, INPUT_REQUEST_INSTRUCTIONS } from './input-request.js';

const SESSION_ERROR_GRACE_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export type SdkRunResult = {
  readonly status: 'complete' | 'failed' | 'awaiting_input';
  readonly summary?: string;
  readonly error?: string;
  readonly question?: string;
};

export type RunningAgentSdkTask = {
  readonly sessionId: string | null;
  readonly baseUrl?: string;
  readonly done: Promise<SdkRunResult>;
  sendMessage(message: string, attachmentIds?: readonly string[]): Promise<void>;
  abort(): Promise<void>;
};

type RunAgentSdkTaskInput = {
  readonly task: WorkerTaskAssignment;
  readonly workingDirectory: string;
  readonly sendEvent: (event: AgentEvent) => Promise<void>;
  readonly providerFactory?: (agentType: AgentType) => AgentProvider;
};

type WorkerEventMetadata = NonNullable<AgentEvent['metadata']>;

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

function sanitizeLocalText(content: string, workspacePath: string): string {
  return content.replaceAll(workspacePath, '[local workspace]');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function sanitizeMetadata(
  metadata: CoreEvent['metadata'] | undefined,
  workspacePath: string,
): AgentEvent['metadata'] | undefined {
  const record = asRecord(metadata);
  if (!record) return undefined;
  const result: AgentEvent['metadata'] = {};
  const file = typeof record.file === 'string' ? sanitizeLocalText(record.file, workspacePath) : undefined;
  if (file) result.file = file;
  const fileEventType = typeof record.fileEventType === 'string' ? record.fileEventType : undefined;
  if (fileEventType) result.fileEventType = fileEventType;
  const language = typeof record.language === 'string' ? record.language : undefined;
  if (language) result.language = language;
  const command = typeof record.command === 'string' ? sanitizeLocalText(record.command, workspacePath) : undefined;
  if (command) result.command = command;
  const diff = typeof record.diff === 'string' ? sanitizeLocalText(record.diff, workspacePath) : undefined;
  if (diff) result.diff = diff;
  if (typeof record.agentType === 'string') {
    result.agentType = record.agentType as WorkerEventMetadata['agentType'];
  }
  if (typeof record.duration === 'number' && Number.isFinite(record.duration)) result.duration = record.duration;
  const error = typeof record.error === 'string' ? sanitizeLocalText(record.error, workspacePath) : undefined;
  if (error) result.error = error;
  if (record.clarification_request) {
    result.clarification_request = record.clarification_request as WorkerEventMetadata['clarification_request'];
  }
  if (record.clarification_answer) {
    result.clarification_answer = record.clarification_answer as WorkerEventMetadata['clarification_answer'];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function getOpenCodeBaseUrl(): string | undefined {
  const baseUrl = process.env.OPENCODE_BASE_URL;
  if (!baseUrl) return undefined;

  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Invalid protocol: ${url.protocol}. Must be http: or https:`);
    }
    const hostname = url.hostname;
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (!isLoopback) {
      throw new Error(`Invalid hostname: ${hostname}. Must be loopback (localhost, 127.0.0.1, or [::1])`);
    }
    if (!url.port) {
      throw new Error('Missing port. OPENCODE_BASE_URL must include an explicit port (e.g., http://localhost:4096)');
    }
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw new Error('OPENCODE_BASE_URL must not include path, query, hash, or userinfo');
    }
    return baseUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid OPENCODE_BASE_URL: ${message}`);
  }
}

function providerFor(agentType: AgentType): AgentProvider {
  if (agentType !== 'opencode') throw new Error(`unsupported agent type: ${agentType}`);
  const baseUrl = getOpenCodeBaseUrl();
  return new OpenCodeProvider(baseUrl ? { baseUrl } : undefined);
}

function maybeOpenCodeBaseUrl(agentType: AgentType): string | undefined {
  if (agentType !== 'opencode') return undefined;
  return getOpenCodeBaseUrl();
}

function coerceEventType(candidate: string): AgentEventType {
  return VALID_EVENT_TYPES.has(candidate as AgentEventType) ? candidate as AgentEventType : 'output';
}

export async function runAgentSdkTask(input: RunAgentSdkTaskInput): Promise<SdkRunResult> {
  const running = await startAgentSdkTask(input);
  return running.done;
}

export async function startAgentSdkTask(input: RunAgentSdkTaskInput): Promise<RunningAgentSdkTask> {
  const agentType = input.task.agentType;
  if (!agentType || !isValidAgentType(agentType)) {
    throw new Error('task has no supported agentType');
  }

  const provider = (input.providerFactory ?? providerFor)(agentType);
  await provider.start();

  // The underlying provider's `execute()` can resolve with status 'complete'
  // even when the session never produced real work (observed: an internal
  // server error that isn't reflected in the response's `info.error` field).
  // Track any 'error'-type event independently via the same onEvent stream
  // the provider already emits, so a false "complete" can be overridden.
  let sessionErrorMessage: string | undefined;
  let resolveSessionError: (message: string) => void = () => {};
  const sessionErrorSignal = new Promise<string>((resolve) => { resolveSessionError = resolve; });

  // Output streams as deltas or whole-part snapshots, so this can repeat text;
  // it is only scanned for the input-request marker, never shown to anyone.
  let outputText = '';

  const session = await provider.createSession({
    contextId: input.task.id,
    workingDirectory: input.workingDirectory,
    systemPrompt: 'Work in the locally configured workspace. Follow the workspace instructions and skills. '
      + `${INPUT_REQUEST_INSTRUCTIONS} `
      + `Task title: ${input.task.title}`,
    onEvent: (event: CoreEvent) => {
      if (event.type === 'output') outputText += event.content;
      const metadata = sanitizeMetadata(event.metadata, input.workingDirectory);
      const mapped: AgentEvent = {
        id: event.id || uuid(),
        taskId: input.task.id,
        type: coerceEventType(event.type),
        content: sanitizeLocalText(event.content, input.workingDirectory),
        timestamp: event.timestamp,
        ...(metadata ? { metadata } : {}),
      };
      if (mapped.type === 'error' && sessionErrorMessage === undefined) {
        sessionErrorMessage = mapped.content || 'agent session reported an error';
        resolveSessionError(sessionErrorMessage);
      }
      void input.sendEvent(mapped).catch((error: unknown) => {
        console.error(`[worker] event upload failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await session.destroy();
    await provider.stop();
  };

  const done = (async (): Promise<SdkRunResult> => {
    try {
      // The provider deletes its sessions on cleanup, so a resumed task starts
      // a fresh session carrying the question and answer as context.
      const prompt = `${input.task.title}\n\n${input.task.description}`
        + (input.task.resume ? `\n\n${buildResumeContext(input.task.resume)}` : '');
      const result = await session.execute(prompt);
      if (result.status === 'complete') {
        const late = await Promise.race([
          sessionErrorSignal.then((message) => ({ message })),
          sleep(SESSION_ERROR_GRACE_MS).then(() => undefined),
        ]);
        if (late) {
          return { status: 'failed', summary: 'Agent SDK task failed', error: late.message };
        }
        const question = extractInputRequest(outputText);
        if (question) {
          return {
            status: 'awaiting_input',
            question: sanitizeLocalText(question, input.workingDirectory),
            summary: 'Agent SDK task is waiting for input',
          };
        }
        return {
          status: 'complete',
          summary: 'Agent SDK task completed',
        };
      }
      return {
        status: 'failed',
        summary: 'Agent SDK task failed',
        ...(result.error ? { error: sanitizeLocalText(result.error, input.workingDirectory) } : {}),
      };
    } catch (error: unknown) {
      return {
        status: 'failed',
        summary: 'Agent SDK task failed',
        error: sanitizeLocalText(error instanceof Error ? error.message : String(error), input.workingDirectory),
      };
    } finally {
      await cleanup();
    }
  })();

  return {
    sessionId: session.sessionId ?? null,
    ...(maybeOpenCodeBaseUrl(agentType) ? { baseUrl: maybeOpenCodeBaseUrl(agentType) } : {}),
    done,
    sendMessage: async (message: string, _attachmentIds?: readonly string[]) => {
      outputText = '';
      await session.send(message);
    },
    abort: async () => {
      await session.abort();
    },
  };
}
