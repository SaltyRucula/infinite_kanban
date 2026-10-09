import {
  isValidAgentTimeoutMinutes,
  isValidAgentType,
  isValidPriority,
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_AGENT_TIMEOUT_MINUTES,
  MAX_AGENT_TIMEOUT_MINUTES,
} from '@ai-agent-board/shared/constants.js';
import type { Message, Part } from '@a2a-js/sdk';
import type { AgentType, Priority, TaskProvenance } from '../types.js';

/**
 * What an A2A peer is allowed to ask the board for.
 *
 * Deliberately narrow: everything that decides *where* work runs
 * (`repoPath`, `worktreePath`, worker assignment) stays board-side policy,
 * resolved from the named project. A peer that sends such a field is refused
 * rather than ignored — see `BOARD_PRIVATE_FIELDS`.
 */
export interface BoardWorkRequest {
  readonly project: string;
  readonly title: string;
  readonly description: string;
  readonly agentType?: AgentType;
  readonly priority?: Priority;
  readonly baseBranch?: string;
  readonly branchName?: string;
  readonly timeoutMinutes?: number;
  readonly labels?: readonly string[];
  readonly autoStart: boolean;
  readonly review: boolean;
  /** Stable key for replay safety; defaults to the client's `messageId`. */
  readonly idempotencyKey: string;
  readonly provenance?: TaskProvenance;
}

export type IntakeResult =
  | { readonly ok: true; readonly request: BoardWorkRequest }
  | { readonly ok: false; readonly error: string };

/** Fields only the board may decide. Accepting any of these would be a path-disclosure bug. */
export const BOARD_PRIVATE_FIELDS: readonly string[] = [
  'repoPath', 'worktreePath', 'assignedWorkerId', 'workerClaimTokenHash', 'workerLeaseExpiresAt',
  'externalSource', 'externalKey', 'agentStatus', 'columnId', 'projectId', 'id',
];

const KNOWN_FIELDS: readonly string[] = [
  'project', 'title', 'description', 'agent', 'agentType', 'priority', 'baseBranch', 'branchName',
  'timeoutMinutes', 'timeout_minutes', 'labels', 'autoStart', 'auto_start', 'mode', 'useWorktree',
  'isolation', 'idempotencyKey', 'provenance', 'origin',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textOf(parts: readonly Part[]): string {
  return parts
    .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
    .filter((value) => value.length > 0)
    .join('\n\n')
    .trim();
}

function structuredOf(parts: readonly Part[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const part of parts) {
    if (part.content?.$case === 'data' && isRecord(part.content.value)) {
      Object.assign(merged, part.content.value);
    }
  }
  return merged;
}

/** Keeps the same shape and allowlist as the former orchestration facade. */
function sanitizeProvenance(value: unknown): TaskProvenance | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  const mappings: Array<[string, keyof TaskProvenance]> = [
    ['sourceProfile', 'sourceProfile'],
    ['profile', 'sourceProfile'],
    ['sourcePlatform', 'sourcePlatform'],
    ['platform', 'sourcePlatform'],
    ['sourceSession', 'sourceSession'],
    ['sessionId', 'sourceSession'],
    ['sourceMessage', 'sourceMessage'],
    ['messageId', 'sourceMessage'],
    ['requestedBy', 'requestedBy'],
  ];
  for (const [inputKey, outputKey] of mappings) {
    const item = value[inputKey];
    if (typeof item === 'string' && item.trim() && !(outputKey in output)) {
      output[outputKey] = item.trim().slice(0, 500);
    }
  }
  if (isRecord(value.origin)) output.origin = value.origin;
  return Object.keys(output).length ? output as TaskProvenance : undefined;
}

const GIT_REF_RE = /^[A-Za-z0-9._\-/]+$/;

function validGitRef(ref: unknown): ref is string {
  return typeof ref === 'string'
    && GIT_REF_RE.test(ref)
    && !ref.includes('..')
    && !ref.endsWith('.lock')
    && ref.length <= 200;
}

function labelList(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const labels = value.map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''));
  if (labels.some((label) => !label || label.length > 100)) return null;
  return [...new Set(labels)];
}

/**
 * Parses an inbound A2A `Message` into a board work request.
 *
 * Peers may describe the work in plain text (first line is the title) and
 * refine it with a structured data part or message metadata; a text-only
 * agent and a board-aware orchestrator both work without special cases.
 */
export function intakeWorkRequest(message: Message): IntakeResult {
  const fields: Record<string, unknown> = {
    ...structuredOf(message.parts),
    ...(isRecord(message.metadata) ? message.metadata : {}),
  };

  const offending = BOARD_PRIVATE_FIELDS.filter((field) => field in fields);
  if (offending.length > 0) {
    return { ok: false, error: `the board decides these fields, they cannot be requested: ${offending.join(', ')}` };
  }
  const unknown = Object.keys(fields).filter((field) => !KNOWN_FIELDS.includes(field) && !field.includes('://'));
  if (unknown.length > 0) {
    return { ok: false, error: `unsupported request fields: ${unknown.join(', ')}` };
  }

  const project = typeof fields.project === 'string' ? fields.project.trim() : '';
  if (!project) return { ok: false, error: 'project is required (id, name, or alias)' };

  const text = textOf(message.parts);
  const [firstLine, ...rest] = text.split('\n');
  const title = (typeof fields.title === 'string' && fields.title.trim() ? fields.title.trim() : firstLine ?? '').trim();
  if (!title) return { ok: false, error: 'title is required (send it in metadata or as the first line of the message)' };
  if (title.length > MAX_TITLE_LENGTH) return { ok: false, error: `title must be at most ${MAX_TITLE_LENGTH} characters` };

  const description = typeof fields.description === 'string'
    ? fields.description
    : (typeof fields.title === 'string' && fields.title.trim() ? text : rest.join('\n').trim());
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters` };
  }

  const agentType = fields.agentType ?? fields.agent;
  if (agentType !== undefined && !isValidAgentType(agentType)) {
    return { ok: false, error: 'agent must be a supported agent type' };
  }
  const priority = fields.priority;
  if (priority !== undefined && !isValidPriority(priority)) {
    return { ok: false, error: 'invalid priority' };
  }
  const timeoutMinutes = fields.timeoutMinutes ?? fields.timeout_minutes;
  if (timeoutMinutes !== undefined && !isValidAgentTimeoutMinutes(timeoutMinutes)) {
    return { ok: false, error: `timeoutMinutes must be an integer between ${MIN_AGENT_TIMEOUT_MINUTES} and ${MAX_AGENT_TIMEOUT_MINUTES}` };
  }
  if (fields.baseBranch !== undefined && !validGitRef(fields.baseBranch)) {
    return { ok: false, error: 'baseBranch is not a valid git ref' };
  }
  if (fields.branchName !== undefined && !validGitRef(fields.branchName)) {
    return { ok: false, error: 'branchName is not a valid git ref' };
  }
  const labels = labelList(fields.labels);
  if (labels === null) return { ok: false, error: 'labels must be an array of short strings' };

  const autoStart = fields.autoStart ?? fields.auto_start ?? true;
  if (typeof autoStart !== 'boolean') return { ok: false, error: 'autoStart must be a boolean' };

  // Coding work on this board always runs in a git worktree; a peer asking for
  // anything else is refused rather than silently upgraded.
  const isolation = fields.isolation ?? fields.useWorktree;
  if (isolation !== undefined && isolation !== 'worktree' && isolation !== true) {
    return { ok: false, error: 'coding tasks require worktree isolation' };
  }

  const mode = fields.mode;
  if (mode !== undefined && mode !== 'review' && mode !== 'implementation') {
    return { ok: false, error: "mode must be 'implementation' or 'review'" };
  }

  const idempotencyKey = typeof fields.idempotencyKey === 'string' && fields.idempotencyKey.trim()
    ? fields.idempotencyKey.trim()
    : message.messageId;
  if (!idempotencyKey) return { ok: false, error: 'messageId is required so replays cannot duplicate work' };
  if (idempotencyKey.length > 200) return { ok: false, error: 'idempotency key is too long' };

  return {
    ok: true,
    request: {
      project,
      title,
      description,
      ...(agentType === undefined ? {} : { agentType: agentType as AgentType }),
      ...(priority === undefined ? {} : { priority: priority as Priority }),
      ...(fields.baseBranch === undefined ? {} : { baseBranch: fields.baseBranch as string }),
      ...(fields.branchName === undefined ? {} : { branchName: fields.branchName as string }),
      ...(timeoutMinutes === undefined ? {} : { timeoutMinutes: timeoutMinutes as number }),
      ...(labels === undefined ? {} : { labels }),
      autoStart,
      review: mode === 'review',
      idempotencyKey,
      ...(sanitizeProvenance(fields.provenance ?? fields.origin) === undefined
        ? {}
        : { provenance: sanitizeProvenance(fields.provenance ?? fields.origin) }),
    },
  };
}
