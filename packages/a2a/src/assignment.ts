import { Role, type Message, type Part } from '@a2a-js/sdk';
import {
  WORKER_TASK_ASSIGNMENT_KEYS,
  type WorkerTaskAssignment,
} from '@ai-agent-board/shared/types.js';
import { BOARD_DATA_MEDIA_TYPE, BOARD_EXTENSION_URI, EXT_ASSIGNMENT } from './extension.js';

/**
 * Serializing a task handoff for a remote executor.
 *
 * `WORKER_TASK_ASSIGNMENT_KEYS` is the repo's existing, type-enforced
 * allowlist of what may leave the board (no host paths, no repo roots). It
 * stays the single gate here: the A2A message is built by projecting the
 * assignment through that list, so a new field cannot escape by accident.
 *
 * See `docs/specs/a2a-protocol-adoption.md` §4.4.
 */
const ASSIGNMENT_KEYS: ReadonlySet<string> = new Set<string>(WORKER_TASK_ASSIGNMENT_KEYS);

function pickAllowedFields(assignment: WorkerTaskAssignment): Record<string, unknown> {
  const source = assignment as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of WORKER_TASK_ASSIGNMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function textPart(value: string): Part {
  return { content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}

function dataPart(value: unknown): Part {
  return { content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: BOARD_DATA_MEDIA_TYPE };
}

/** Human-readable prompt text, for A2A agents that only understand text. */
export function assignmentPrompt(assignment: WorkerTaskAssignment): string {
  const lines = [assignment.title];
  if (assignment.description) lines.push('', assignment.description);
  if (assignment.project?.goal) lines.push('', `Project goal: ${assignment.project.goal}`);
  if (assignment.project?.context) lines.push(`Project context: ${assignment.project.context}`);
  if (assignment.mode === 'review') {
    lines.push('', 'Mode: review. Validate the existing implementation and report a verdict; do not re-implement.');
  }
  if (assignment.resume) {
    lines.push('', `Answer to your question "${assignment.resume.question}": ${assignment.resume.answer}`);
  }
  return lines.join('\n');
}

/** Board task assignment → A2A `Message` parts (text for any agent, data for board peers). */
export function assignmentToParts(assignment: WorkerTaskAssignment): Part[] {
  return [textPart(assignmentPrompt(assignment)), dataPart(pickAllowedFields(assignment))];
}

/** Board task assignment → full A2A `Message` ready for `SendMessage`. */
export function assignmentToMessage(
  assignment: WorkerTaskAssignment,
  options: { readonly messageId: string; readonly contextId?: string; readonly taskId?: string },
): Message {
  return {
    messageId: options.messageId,
    contextId: options.contextId ?? '',
    taskId: options.taskId ?? '',
    role: Role.ROLE_USER,
    parts: assignmentToParts(assignment),
    metadata: { [EXT_ASSIGNMENT]: pickAllowedFields(assignment) },
    extensions: [BOARD_EXTENSION_URI],
    referenceTaskIds: [],
  };
}

export type AssignmentDecodeResult =
  | { readonly ok: true; readonly assignment: WorkerTaskAssignment }
  | { readonly ok: false; readonly error: string };

/**
 * A2A `Message` → board task assignment, for a worker receiving work over
 * A2A. Unknown fields are rejected rather than ignored: a peer that sends
 * `repoPath` or any other board-private key is a bug or an attack, not a
 * forward-compatible client.
 */
export function assignmentFromMessage(message: Message): AssignmentDecodeResult {
  const candidate = findAssignmentPayload(message);
  if (!candidate) return { ok: false, error: 'no board assignment payload found in message' };

  const unknownKeys = Object.keys(candidate).filter((key) => !ASSIGNMENT_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `unexpected assignment fields: ${unknownKeys.join(', ')}` };
  }
  if (typeof candidate.id !== 'string' || !candidate.id) return { ok: false, error: 'assignment id is required' };
  if (typeof candidate.title !== 'string' || !candidate.title) return { ok: false, error: 'assignment title is required' };
  if (typeof candidate.description !== 'string') return { ok: false, error: 'assignment description must be a string' };
  if (!Array.isArray(candidate.labels)) return { ok: false, error: 'assignment labels must be an array' };

  return { ok: true, assignment: candidate as unknown as WorkerTaskAssignment };
}

function findAssignmentPayload(message: Message): Record<string, unknown> | undefined {
  const fromMetadata = message.metadata?.[EXT_ASSIGNMENT];
  if (isRecord(fromMetadata)) return fromMetadata;
  for (const part of message.parts) {
    if (part.content?.$case === 'data' && isRecord(part.content.value)) return part.content.value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
