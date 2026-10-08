import { Role, TaskState, type Artifact, type Part, type TaskArtifactUpdateEvent, type TaskStatusUpdateEvent } from '@a2a-js/sdk';
import {
  classifyAgentEventImportance,
  type AgentEvent,
  type AgentEventImportance,
} from '@ai-agent-board/shared/types.js';
import { BOARD_DATA_MEDIA_TYPE, BOARD_EXTENSION_URI, EXT_AGENT_EVENT } from './extension.js';

/**
 * A board `AgentEvent` becomes either a status update (progress) or an
 * artifact update (the run's deliverable). See
 * `docs/specs/a2a-protocol-adoption.md` §4.2.
 */
export type BoardTaskUpdate =
  | { readonly kind: 'statusUpdate'; readonly data: TaskStatusUpdateEvent }
  | { readonly kind: 'artifactUpdate'; readonly data: TaskArtifactUpdateEvent };

export interface EventMappingContext {
  readonly contextId: string;
  /** Summary text to attach to the completion artifact, when the board has one. */
  readonly summary?: string;
}

function textPart(value: string): Part {
  return {
    content: { $case: 'text', value },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  };
}

function dataPart(value: unknown): Part {
  return {
    content: { $case: 'data', value },
    metadata: undefined,
    filename: '',
    mediaType: BOARD_DATA_MEDIA_TYPE,
  };
}

function envelope(event: AgentEvent): Record<string, unknown> {
  return {
    [EXT_AGENT_EVENT]: {
      id: event.id,
      taskId: event.taskId,
      type: event.type,
      timestamp: event.timestamp,
      importance: eventImportance(event),
      ...(event.metadata ? { metadata: event.metadata } : {}),
    },
  };
}

function eventImportance(event: AgentEvent): AgentEventImportance {
  return event.importance ?? classifyAgentEventImportance(event.type);
}

function isoTimestamp(value: number): string {
  return new Date(value).toISOString();
}

/**
 * The parts a peer without the board extension still understands: the event
 * text, plus a structured part for milestones so file/command/test details are
 * machine-readable rather than buried in prose.
 */
function partsFor(event: AgentEvent): Part[] {
  const parts: Part[] = [];
  if (event.content) parts.push(textPart(event.content));
  const metadata = event.metadata;
  if (metadata && eventImportance(event) === 'milestone') {
    const structured: Record<string, unknown> = {};
    if (metadata.file) structured.file = metadata.file;
    if (metadata.command) structured.command = metadata.command;
    if (metadata.diff) structured.diff = metadata.diff;
    if (metadata.language) structured.language = metadata.language;
    if (typeof metadata.duration === 'number') structured.duration = metadata.duration;
    if (metadata.error) structured.error = metadata.error;
    if (Object.keys(structured).length > 0) parts.push(dataPart(structured));
  }
  return parts;
}

/** Board `AgentEvent` → A2A task update. */
export function agentEventToTaskUpdate(event: AgentEvent, context: EventMappingContext): BoardTaskUpdate {
  const common = {
    taskId: event.taskId,
    contextId: context.contextId,
    metadata: envelope(event),
  };

  if (event.type === 'complete') {
    const usage = event.metadata;
    const parts: Part[] = [textPart(context.summary ?? event.content ?? 'Run complete.')];
    const result: Record<string, unknown> = {};
    if (usage?.agentType) result.agentType = usage.agentType;
    if (typeof usage?.duration === 'number') result.duration = usage.duration;
    if (typeof usage?.inputTokens === 'number') result.inputTokens = usage.inputTokens;
    if (typeof usage?.outputTokens === 'number') result.outputTokens = usage.outputTokens;
    if (typeof usage?.costUsd === 'number') result.costUsd = usage.costUsd;
    if (Object.keys(result).length > 0) parts.push(dataPart(result));
    const artifact: Artifact = {
      artifactId: event.id,
      name: 'run-result',
      description: 'Board run result: summary and usage.',
      parts,
      metadata: undefined,
      extensions: [BOARD_EXTENSION_URI],
    };
    return {
      kind: 'artifactUpdate',
      data: { ...common, artifact, append: false, lastChunk: true },
    };
  }

  const state = event.type === 'error' ? TaskState.TASK_STATE_FAILED : TaskState.TASK_STATE_WORKING;
  return {
    kind: 'statusUpdate',
    data: {
      ...common,
      status: {
        state,
        message: {
          messageId: event.id,
          contextId: context.contextId,
          taskId: event.taskId,
          role: Role.ROLE_AGENT,
          parts: partsFor(event),
          metadata: undefined,
          extensions: [BOARD_EXTENSION_URI],
          referenceTaskIds: [],
        },
        timestamp: isoTimestamp(event.timestamp),
      },
    },
  };
}

/**
 * A2A task update → board `AgentEvent`, used when the board consumes a stream
 * from a remote A2A executor. Peers that carry the board extension round-trip
 * exactly; foreign peers are mapped to a best-effort `output`/`error` event.
 */
export function taskUpdateToAgentEvent(update: BoardTaskUpdate): AgentEvent | undefined {
  const envelopeValue = update.data.metadata?.[EXT_AGENT_EVENT] as
    | { id?: unknown; taskId?: unknown; type?: unknown; timestamp?: unknown; importance?: unknown; metadata?: unknown }
    | undefined;

  const text = collectText(update);

  if (envelopeValue && typeof envelopeValue.id === 'string' && typeof envelopeValue.type === 'string') {
    return {
      id: envelopeValue.id,
      taskId: typeof envelopeValue.taskId === 'string' ? envelopeValue.taskId : update.data.taskId,
      type: envelopeValue.type as AgentEvent['type'],
      content: text,
      timestamp: typeof envelopeValue.timestamp === 'number' ? envelopeValue.timestamp : Date.now(),
      importance: envelopeValue.importance as AgentEventImportance | undefined,
      ...(envelopeValue.metadata ? { metadata: envelopeValue.metadata as AgentEvent['metadata'] } : {}),
    };
  }

  if (update.kind === 'artifactUpdate') {
    return {
      id: update.data.artifact?.artifactId ?? `${update.data.taskId}-complete`,
      taskId: update.data.taskId,
      type: 'complete',
      content: text,
      timestamp: Date.now(),
      importance: 'milestone',
    };
  }

  const state = update.data.status?.state;
  if (state === undefined) return undefined;
  const failed = state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_REJECTED;
  return {
    id: update.data.status?.message?.messageId ?? `${update.data.taskId}-${Date.now()}`,
    taskId: update.data.taskId,
    type: failed ? 'error' : 'output',
    content: text,
    timestamp: Date.now(),
    importance: failed ? 'milestone' : 'detail',
  };
}

function collectText(update: BoardTaskUpdate): string {
  const parts = update.kind === 'artifactUpdate'
    ? update.data.artifact?.parts ?? []
    : update.data.status?.message?.parts ?? [];
  return parts
    .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
    .filter((value) => value.length > 0)
    .join('\n');
}
