import { v4 as uuid } from 'uuid';
import {
  ClaudeProvider,
  CodexProvider,
  CopilotProvider,
  GrokProvider,
  HermesProvider,
  OpenClawProvider,
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

export type SdkRunResult = {
  readonly status: 'complete' | 'failed';
  readonly summary?: string;
  readonly error?: string;
};

type RunAgentSdkTaskInput = {
  readonly task: WorkerTaskAssignment;
  readonly workingDirectory: string;
  readonly sendEvent: (event: AgentEvent) => Promise<void>;
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
  switch (agentType) {
    case 'copilot':
      return new CopilotProvider();
    case 'claude':
      return new ClaudeProvider();
    case 'codex':
      return new CodexProvider();
    case 'opencode': {
      const baseUrl = getOpenCodeBaseUrl();
      return new OpenCodeProvider(baseUrl ? { baseUrl } : undefined);
    }
    case 'hermes':
      return new HermesProvider();
    case 'openclaw':
      return new OpenClawProvider();
    case 'grok':
      return new GrokProvider();
    default:
      throw new Error(`unsupported agent type: ${agentType satisfies never}`);
  }
}

function coerceEventType(candidate: string): AgentEventType {
  return VALID_EVENT_TYPES.has(candidate as AgentEventType) ? candidate as AgentEventType : 'output';
}

export async function runAgentSdkTask(input: RunAgentSdkTaskInput): Promise<SdkRunResult> {
  const agentType = input.task.agentType;
  if (!agentType || !isValidAgentType(agentType)) {
    throw new Error('task has no supported agentType');
  }

  const provider = providerFor(agentType);
  await provider.start();
  const session = await provider.createSession({
    contextId: input.task.id,
    workingDirectory: input.workingDirectory,
    systemPrompt: 'Work in the locally configured workspace. Follow the workspace instructions and skills. '
      + `Task title: ${input.task.title}`,
    onEvent: (event: CoreEvent) => {
      const metadata = sanitizeMetadata(event.metadata, input.workingDirectory);
      const mapped: AgentEvent = {
        id: event.id || uuid(),
        taskId: input.task.id,
        type: coerceEventType(event.type),
        content: sanitizeLocalText(event.content, input.workingDirectory),
        timestamp: event.timestamp,
        ...(metadata ? { metadata } : {}),
      };
      void input.sendEvent(mapped).catch((error: unknown) => {
        console.error(`[worker] event upload failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });

  try {
    const result = await session.execute(`${input.task.title}\n\n${input.task.description}`);
    if (result.status === 'complete') {
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
  } finally {
    await session.destroy();
    await provider.stop();
  }
}
