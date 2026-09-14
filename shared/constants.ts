import type { ColumnId, Priority, AgentStatus, AgentType, WorkerStatus } from './types.js';

export const VALID_PRIORITIES: readonly Priority[] = ['low', 'medium', 'high', 'critical'] as const;
export const VALID_COLUMNS: readonly ColumnId[] = ['backlog', 'in-progress', 'pending', 'review', 'done'] as const;
export const VALID_AGENT_STATUSES: readonly AgentStatus[] = ['idle', 'planning', 'executing', 'awaiting_clarification', 'complete', 'failed'] as const;
export const VALID_AGENT_TYPES: readonly AgentType[] = ['copilot', 'claude', 'codex', 'opencode', 'hermes', 'openclaw', 'grok'] as const;
export const VALID_WORKER_STATUSES: readonly WorkerStatus[] = ['online', 'offline', 'disabled'] as const;

export const VALID_AGENT_STATUS_TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  idle: ['planning'],
  planning: ['executing', 'failed'],
  executing: ['awaiting_clarification', 'complete', 'failed'],
  awaiting_clarification: ['executing', 'failed'],
  complete: ['idle'],
  failed: ['idle'],
};

/** Allowed column transitions. Key = current column, value = columns you can move to. */
export const VALID_TRANSITIONS: Record<ColumnId, readonly ColumnId[]> = {
  'backlog': ['in-progress'],
  'in-progress': ['backlog', 'review'],
  'pending': ['in-progress'],
  'review': ['done', 'in-progress'],
  'done': ['in-progress'],
};

export function isValidPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (VALID_PRIORITIES as readonly string[]).includes(value);
}

export function isValidColumnId(value: unknown): value is ColumnId {
  return typeof value === 'string' && (VALID_COLUMNS as readonly string[]).includes(value);
}

export function isValidAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === 'string' && (VALID_AGENT_STATUSES as readonly string[]).includes(value);
}

export function isValidAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && (VALID_AGENT_TYPES as readonly string[]).includes(value);
}

export function isValidWorkerStatus(value: unknown): value is WorkerStatus {
  return typeof value === 'string' && (VALID_WORKER_STATUSES as readonly string[]).includes(value);
}

export function canTransitionAgentStatus(from: AgentStatus, to: AgentStatus): boolean {
  return VALID_AGENT_STATUS_TRANSITIONS[from].includes(to);
}

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const MAX_LABELS = 20;
export const MAX_LABEL_LENGTH = 50;
export const MAX_AGENT_PREFERENCE_LENGTH = 100;
export const MIN_AGENT_TIMEOUT_MINUTES = 1;
export const MAX_AGENT_TIMEOUT_MINUTES = 240;
export const MAX_GROUP_CHILDREN = 20;
export const MIN_GROUP_CHILDREN = 2;

export function isValidAgentTimeoutMinutes(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_AGENT_TIMEOUT_MINUTES
    && value <= MAX_AGENT_TIMEOUT_MINUTES;
}

export function isValidMaxConcurrency(value: unknown, childCount: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= childCount;
}

export const CLAIMABLE_AGENT_STATUSES: readonly AgentStatus[] = ['idle', 'planning', 'complete', 'failed'];

export const CLAIMABLE_AGENT_STATUS_SQL_LIST = CLAIMABLE_AGENT_STATUSES.map((s) => `'${s}'`).join(',');

// --- Remote worker registration / lease timing ---
// A worker sends a heartbeat every WORKER_HEARTBEAT_INTERVAL_MS; the server's
// staleness sweep (running on the same cadence) marks a worker 'offline' once
// WORKER_STALE_AFTER_MS has elapsed since its last heartbeat, and fails any
// task it was executing (see startup-recovery-style handling in the server).
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const WORKER_STALE_AFTER_MS = 45_000;
// How often a worker polls GET /api/workers/me/assignments for claimable work.
export const WORKER_ASSIGNMENT_POLL_INTERVAL_MS = 5_000;
// A claimed task's lease; renewed each heartbeat that reports the task as its
// current task. If the lease lapses without renewal, the task is treated as
// abandoned by that worker and failed (worker_offline), not silently retried.
export const WORKER_TASK_LEASE_MS = 60_000;
export const WORKER_MAX_NAME_LENGTH = 100;
