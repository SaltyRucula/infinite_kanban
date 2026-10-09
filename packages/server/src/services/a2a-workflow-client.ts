import type { WorkflowAction, WorkflowTicket } from './workflow-policy.js';
import { isAllowedA2AUrl, normalizeProtocolVersion, type A2AProtocolVersion } from '@ai-agent-board/a2a/cards.js';

/**
 * The wire format differs between A2A versions in ways that are easy to get
 * wrong: v1.0 uses PascalCase JSON-RPC methods and flattened `Part` objects
 * (`{ "text": "..." }`, the proto `oneof` serialized to JSON), while v0.3
 * uses slash-separated methods and tagged parts (`{ "kind": "text", ... }`).
 * A v1.0 client must also send the `A2A-Version` header: when it is absent
 * the agent assumes 0.3 (A2A spec §3.6.1).
 */
export type { A2AProtocolVersion };

export const A2A_VERSION_HEADER = 'A2A-Version';
export const DEFAULT_A2A_PROTOCOL_VERSION: A2AProtocolVersion = '1.0';

type A2AMethod = 'send' | 'get' | 'cancel';

const METHOD_NAMES: Readonly<Record<A2AProtocolVersion, Readonly<Record<A2AMethod, string>>>> = {
  '1.0': { send: 'SendMessage', get: 'GetTask', cancel: 'CancelTask' },
  '0.3': { send: 'message/send', get: 'tasks/get', cancel: 'tasks/cancel' },
};

/** Resolves the dialect to use for an agent, from the version its card advertised. */
export function negotiateProtocolVersion(advertised: string | undefined): A2AProtocolVersion {
  if (advertised === undefined) return DEFAULT_A2A_PROTOCOL_VERSION;
  const resolved = normalizeProtocolVersion(advertised);
  if (resolved === undefined) {
    throw new A2AExecutorError('protocol', `A2A protocol version is not supported: ${advertised}.`);
  }
  return resolved;
}

/** Board-neutral text part; the wire shape is chosen per protocol version. */
export interface A2ATextPart {
  readonly text: string;
}

export interface A2AMessage {
  readonly role: 'ROLE_USER';
  readonly messageId: string;
  readonly parts: readonly A2ATextPart[];
}

export interface A2AMessageSendParams {
  readonly message: A2AMessage;
  readonly metadata: Readonly<Record<string, string | number>>;
}

export interface A2ADispatchReceipt {
  readonly remoteTaskId: string;
}

export type A2ARemoteTaskState = 'pending' | 'running' | 'input_required' | 'completed' | 'failed' | 'canceled';

export interface A2ARemoteTaskUpdate {
  readonly state: A2ARemoteTaskState;
  readonly artifacts: readonly unknown[];
}

export type A2AFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface JsonRpcA2AExecutorOptions {
  readonly fetcher?: A2AFetch;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  /** Dialect to speak; defaults to v1.0. Drive this from the registration's Agent Card. */
  readonly protocolVersion?: A2AProtocolVersion;
}

/** Typed failures let the workflow layer escalate a remote-agent problem safely. */
export class A2AExecutorError extends Error {
  constructor(
    readonly code: 'transport' | 'protocol',
    message: string,
    readonly statusCode?: number,
    readonly rpcCode?: number,
    readonly rpcData?: unknown,
  ) {
    super(message);
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizedState(value: unknown): A2ARemoteTaskState {
  if (typeof value !== 'string') {
    throw new A2AExecutorError('protocol', 'A2A task status must include a string state.');
  }

  switch (value.toLowerCase().replace(/^task_state_/, '').replace(/-/g, '_')) {
    case 'submitted':
    case 'pending':
      return 'pending';
    case 'working':
    case 'running':
      return 'running';
    case 'input_required':
      return 'input_required';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    default:
      throw new A2AExecutorError('protocol', `A2A task state is not supported: ${value}.`);
  }
}

function parseTaskResult(value: unknown, expectedTaskId?: string): { id: string; update: A2ARemoteTaskUpdate } {
  if (!isRecord(value)) {
    throw new A2AExecutorError('protocol', 'A2A JSON-RPC result must be a task object.');
  }
  // SendMessage may legitimately answer with a Message instead of a Task
  // (spec §3.1.1). The board needs a trackable task, so say so plainly
  // instead of failing on a missing `id`.
  if (value.status === undefined && (value.messageId !== undefined || value.role !== undefined)) {
    throw new A2AExecutorError('protocol', 'A2A agent answered with a direct message; the board requires a task it can track.');
  }
  const id = readString(value.id);
  if (!id) {
    throw new A2AExecutorError('protocol', 'A2A task result must include a non-empty id.');
  }
  if (expectedTaskId !== undefined && id !== expectedTaskId) {
    throw new A2AExecutorError('protocol', 'A2A task result id did not match the requested task.');
  }
  const status = value.status;
  if (!isRecord(status)) {
    throw new A2AExecutorError('protocol', 'A2A task result must include a status object.');
  }
  const artifacts = value.artifacts;
  if (artifacts !== undefined && !Array.isArray(artifacts)) {
    throw new A2AExecutorError('protocol', 'A2A task artifacts must be an array when present.');
  }

  return {
    id,
    update: {
      state: normalizedState(status.state),
      artifacts: artifacts ?? [],
    },
  };
}

/**
 * Generic A2A JSON-RPC executor. It accepts only an A2A endpoint and explicit
 * protocol parameters, so worker credentials, local paths, and board secrets
 * are never added to outbound requests.
 */
export class JsonRpcA2AExecutor {
  private readonly endpoint: string;
  private readonly fetcher: A2AFetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly protocolVersion: A2AProtocolVersion;

  constructor(endpoint: string, options: JsonRpcA2AExecutorOptions = {}) {
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new A2AExecutorError('transport', 'A2A endpoint must be an absolute URL.');
    }
    if (!isAllowedA2AUrl(parsedEndpoint)) {
      throw new A2AExecutorError('transport', 'A2A endpoint must use HTTPS or loopback HTTP.');
    }
    if (!Number.isInteger(options.maxRetries ?? 1) || (options.maxRetries ?? 1) < 0 || (options.maxRetries ?? 1) > 3) {
      throw new A2AExecutorError('transport', 'A2A maxRetries must be an integer from 0 to 3.');
    }
    if (!Number.isInteger(options.timeoutMs ?? 15_000) || (options.timeoutMs ?? 15_000) <= 0 || (options.timeoutMs ?? 15_000) > 60_000) {
      throw new A2AExecutorError('transport', 'A2A timeoutMs must be an integer from 1 to 60000.');
    }

    this.endpoint = parsedEndpoint.toString();
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.maxRetries = options.maxRetries ?? 1;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.protocolVersion = options.protocolVersion ?? DEFAULT_A2A_PROTOCOL_VERSION;
  }

  /**
   * Serializes a board-neutral message into the dialect of the negotiated
   * protocol version: flattened parts for v1.0, tagged parts for v0.3.
   */
  private wireParams(params: A2AMessageSendParams): unknown {
    const parts = params.message.parts.map((part) => (this.protocolVersion === '1.0'
      ? { text: part.text }
      : { kind: 'text', text: part.text }));
    return {
      message: {
        role: this.protocolVersion === '1.0' ? 'ROLE_USER' : 'user',
        messageId: params.message.messageId,
        parts,
      },
      metadata: params.metadata,
    };
  }

  async dispatch(params: A2AMessageSendParams): Promise<A2ADispatchReceipt> {
    const method = METHOD_NAMES[this.protocolVersion].send;
    const task = parseTaskResult(
      await this.request(method, params.message.messageId, params.message.messageId, this.wireParams(params)),
    );
    return { remoteTaskId: task.id };
  }

  async getUpdate(remoteTaskId: string): Promise<A2ARemoteTaskUpdate> {
    const requestId = `get:${remoteTaskId}`;
    const method = METHOD_NAMES[this.protocolVersion].get;
    const task = parseTaskResult(await this.request(method, requestId, requestId, { id: remoteTaskId }), remoteTaskId);
    return task.update;
  }

  async cancel(remoteTaskId: string): Promise<void> {
    const requestId = `cancel:${remoteTaskId}`;
    const method = METHOD_NAMES[this.protocolVersion].cancel;
    parseTaskResult(await this.request(method, requestId, requestId, { id: remoteTaskId }), remoteTaskId);
  }

  private async request(method: string, requestId: string, expectedResponseId: string, params: unknown): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params });
    let lastError: A2AExecutorError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            // v1.0 clients MUST declare their version; an absent header makes
            // the agent assume 0.3 (spec §3.6.1).
            ...(this.protocolVersion === '1.0' ? { [A2A_VERSION_HEADER]: '1.0' } : {}),
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          const error = new A2AExecutorError('transport', `A2A request failed with HTTP ${response.status}.`, response.status);
          if (attempt < this.maxRetries && (response.status === 408 || response.status === 429 || response.status >= 500)) {
            lastError = error;
            continue;
          }
          throw error;
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new A2AExecutorError('protocol', 'A2A response must contain valid JSON.', response.status);
        }
        return this.parseJsonRpcResponse(payload, expectedResponseId);
      } catch (error) {
        const typed = error instanceof A2AExecutorError
          ? error
          : new A2AExecutorError('transport', 'A2A request failed.');
        if (attempt < this.maxRetries && typed.code === 'transport' && typed.statusCode === undefined) {
          lastError = typed;
          continue;
        }
        throw typed;
      }
    }

    throw lastError ?? new A2AExecutorError('transport', 'A2A request failed.');
  }

  private parseJsonRpcResponse(payload: unknown, expectedResponseId: string): unknown {
    if (!isRecord(payload) || payload.jsonrpc !== '2.0' || payload.id !== expectedResponseId) {
      throw new A2AExecutorError('protocol', 'A2A response is not a valid JSON-RPC 2.0 response.');
    }
    const hasResult = Object.hasOwn(payload, 'result');
    const hasError = Object.hasOwn(payload, 'error');
    if (hasResult === hasError) {
      throw new A2AExecutorError('protocol', 'A2A JSON-RPC response must contain exactly one of result or error.');
    }
    if (hasError) {
      if (!isRecord(payload.error) || typeof payload.error.code !== 'number' || typeof payload.error.message !== 'string') {
        throw new A2AExecutorError('protocol', 'A2A JSON-RPC error response is malformed.');
      }
      throw new A2AExecutorError('protocol', `A2A JSON-RPC error ${payload.error.code}: ${payload.error.message}`, undefined, payload.error.code, payload.error.data);
    }
    return payload.result;
  }
}

type WorkflowDispatchAction = Extract<WorkflowAction, { readonly type: 'dispatch' }>;

function promptFor(ticket: WorkflowTicket, action: WorkflowDispatchAction): string {
  if (action.role === 'review') {
    return `Review board ticket ${ticket.id}.`;
  }
  if (action.reviewFeedback !== undefined) {
    return `Continue implementation for board ticket ${ticket.id}.\n\nReview feedback:\n${action.reviewFeedback}`;
  }
  return `Implement board ticket ${ticket.id}.`;
}

/**
 * Converts a board-owned workflow dispatch into A2A `message/send` parameters.
 * Transport, Agent Card lookup, and remote task lifecycle handling remain
 * outside this pure mapper.
 */
export function createA2AMessageSendParams(
  ticket: WorkflowTicket,
  action: WorkflowDispatchAction,
  messageId: string,
): A2AMessageSendParams {
  return {
    message: {
      role: 'ROLE_USER',
      messageId,
      parts: [{ text: promptFor(ticket, action) }],
    },
    metadata: {
      'infinite_kanban.ticket_id': ticket.id,
      'infinite_kanban.project_id': ticket.projectId,
      'infinite_kanban.workflow_role': action.role,
      'infinite_kanban.review_round': action.reviewRound,
    },
  };
}
