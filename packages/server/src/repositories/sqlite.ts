import Database from 'better-sqlite3';
import type { Task, Priority, ColumnId, AgentStatus, AgentType, AgentEvent } from '../types.js';
import type { TaskRepository } from './types.js';
import { errorMessage } from '../utils.js';
import { CLAIMABLE_AGENT_STATUS_SQL_LIST, coerceAgentType } from '@ai-agent-board/shared/constants.js';

interface TaskRow {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  column_id: ColumnId;
  agent_status: AgentStatus;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  repo_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  use_worktree: number | null;
  worktree_path: string | null;
  agent_type: AgentType;
  archived: number;
  project_id: string;
  group_id: string | null;
  group_order: number | null;
  summary: string | null;
  external_source: string | null; external_key: string | null; provenance: string | null;
  run_requested_at: number | null; run_claimed_at: number | null;
  timeout_minutes: number | null;
  clarification_request: string | null;
  clarification_answer: string | null;
  assigned_worker_id: string | null;
  worker_claim_token_hash: string | null;
  worker_claimed_at: number | null;
  worker_lease_expires_at: number | null;
  worker_attempt: number;
  labels: string;
  agent_preference: string | null;
}

function parseOptionalJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  return JSON.parse(value) as T;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    columnId: row.column_id,
    agentStatus: row.agent_status,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    repoPath: row.repo_path ?? undefined,
    branchName: row.branch_name ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    useWorktree: row.use_worktree != null ? Boolean(row.use_worktree) : undefined,
    worktreePath: row.worktree_path ?? undefined,
    agentType: coerceAgentType(row.agent_type),
    archived: Boolean(row.archived),
    groupId: row.group_id ?? undefined,
    groupOrder: row.group_order ?? undefined,
    summary: row.summary ?? null,
    externalSource: row.external_source ?? undefined, externalKey: row.external_key ?? undefined,
    provenance: parseOptionalJson(row.provenance),
    runRequestedAt: row.run_requested_at ?? undefined, runClaimedAt: row.run_claimed_at ?? undefined,
    workerClaimTokenHash: row.worker_claim_token_hash ?? undefined,
    workerClaimedAt: row.worker_claimed_at ?? undefined,
    workerLeaseExpiresAt: row.worker_lease_expires_at ?? undefined,
    timeoutMinutes: row.timeout_minutes ?? undefined,
    clarificationRequest: parseOptionalJson(row.clarification_request),
    clarificationAnswer: parseOptionalJson(row.clarification_answer),
    assignedWorkerId: row.assigned_worker_id ?? null,
    labels: parseOptionalJson<string[]>(row.labels) ?? [],
    ...(row.agent_preference == null ? {} : { agentPreference: row.agent_preference }),
  };
}

export class SqliteTaskRepository implements TaskRepository {
  private db: Database.Database;
  private stmts: {
    getAll: Database.Statement;
    getAllIncludingArchived: Database.Statement;
    getArchived: Database.Statement;
    getById: Database.Statement;
    insert: Database.Statement;
    update: Database.Statement;
    delete: Database.Statement;
    count: Database.Statement;
    insertEvent: Database.Statement;
    getEventsByTaskId: Database.Statement;
    deleteEventsByTaskId: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.stmts = {
      getAll: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND archived = 0 AND group_id IS NULL ORDER BY created_at ASC'),
      getAllIncludingArchived: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND group_id IS NULL ORDER BY created_at ASC'),
      getArchived: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND archived = 1 ORDER BY created_at DESC'),
      getById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
      insert: db.prepare(`
        INSERT INTO tasks (id, project_id, title, description, priority, column_id, agent_status, agent_type, created_at, started_at, completed_at,
          repo_path, branch_name, base_branch, use_worktree, worktree_path, archived, group_id, group_order, summary, external_source, external_key, provenance, run_requested_at, run_claimed_at, timeout_minutes, clarification_request, clarification_answer, assigned_worker_id, worker_attempt, labels, agent_preference)
        VALUES (@id, @project_id, @title, @description, @priority, @column_id, @agent_status, @agent_type, @created_at, @started_at, @completed_at,
          @repo_path, @branch_name, @base_branch, @use_worktree, @worktree_path, @archived, @group_id, @group_order, @summary, @external_source, @external_key, @provenance, @run_requested_at, @run_claimed_at, @timeout_minutes, @clarification_request, @clarification_answer, @assigned_worker_id, @worker_attempt, @labels, @agent_preference)
      `),
      update: db.prepare(`
        UPDATE tasks SET
          title = @title,
          description = @description,
          priority = @priority,
          column_id = @column_id,
          agent_status = @agent_status,
          agent_type = @agent_type,
          started_at = @started_at,
          completed_at = @completed_at,
          repo_path = @repo_path,
          branch_name = @branch_name,
          base_branch = @base_branch,
          use_worktree = @use_worktree,
          worktree_path = @worktree_path,
          archived = @archived,
          summary = @summary, run_requested_at = @run_requested_at, run_claimed_at = @run_claimed_at,
          timeout_minutes = @timeout_minutes,
          clarification_request = @clarification_request,
          clarification_answer = @clarification_answer,
          assigned_worker_id = @assigned_worker_id,
          labels = @labels,
          agent_preference = @agent_preference
        WHERE id = @id
      `),
      delete: db.prepare('DELETE FROM tasks WHERE id = ?'),
      count: db.prepare('SELECT COUNT(*) as cnt FROM tasks'),
      insertEvent: db.prepare(`
        INSERT INTO events (id, task_id, type, content, timestamp, metadata)
        VALUES (@id, @task_id, @type, @content, @timestamp, @metadata)
      `),
      getEventsByTaskId: db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY timestamp ASC'),
      deleteEventsByTaskId: db.prepare('DELETE FROM events WHERE task_id = ?'),
    };
  }

  async getAll(includeArchived = false, projectId = 'default'): Promise<Task[]> {
    const stmt = includeArchived ? this.stmts.getAllIncludingArchived : this.stmts.getAll;
    return (stmt.all(projectId) as TaskRow[]).map(rowToTask);
  }

  async getById(id: string): Promise<Task | undefined> {
    const row = this.stmts.getById.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  async getByExternalIdentity(projectId: string, source: string, key: string): Promise<Task | undefined> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND external_source = ? AND external_key = ?').get(projectId, source, key) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  async create(task: Task): Promise<Task> {
    this.stmts.insert.run({
      id: task.id,
      project_id: task.projectId,
      title: task.title,
      description: task.description,
      priority: task.priority,
      column_id: task.columnId,
      agent_status: task.agentStatus,
       agent_type: task.agentType ?? 'opencode',
      created_at: task.createdAt,
      started_at: task.startedAt ?? null,
      completed_at: task.completedAt ?? null,
      repo_path: task.repoPath ?? null,
      branch_name: task.branchName ?? null,
      base_branch: task.baseBranch ?? null,
      use_worktree: task.useWorktree != null ? (task.useWorktree ? 1 : 0) : null,
      worktree_path: task.worktreePath ?? null,
      archived: task.archived ? 1 : 0,
      group_id: task.groupId ?? null,
      group_order: task.groupOrder ?? null,
      summary: task.summary ?? null, external_source: task.externalSource ?? null, external_key: task.externalKey ?? null,
      provenance: task.provenance ? JSON.stringify(task.provenance) : null, run_requested_at: task.runRequestedAt ?? null, run_claimed_at: task.runClaimedAt ?? null,
      timeout_minutes: task.timeoutMinutes ?? null,
      clarification_request: task.clarificationRequest ? JSON.stringify(task.clarificationRequest) : null,
      clarification_answer: task.clarificationAnswer ? JSON.stringify(task.clarificationAnswer) : null,
      assigned_worker_id: task.assignedWorkerId ?? null,
      worker_attempt: 0,
      labels: JSON.stringify(task.labels ?? []),
      agent_preference: task.agentPreference ?? null,
    });
    return task;
  }

  async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
    try { await this.create(task); return { task, created: true }; } catch (err) {
      if (task.externalSource && task.externalKey && err instanceof Error && err.message.includes('UNIQUE')) {
        const existing = await this.getByExternalIdentity(task.projectId, task.externalSource, task.externalKey); if (existing) return { task: existing, created: false };
      } throw err;
    }
  }
  async requestRun(id: string, at: number) { this.db.prepare('UPDATE tasks SET run_requested_at=?, run_claimed_at=NULL WHERE id=?').run(at,id); return this.getById(id); }
  async claimRun(id: string, at: number) { const staleBefore=at-30_000; const r=this.db.prepare(`UPDATE tasks SET run_claimed_at=? WHERE id=? AND run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < ?) AND agent_status IN (${CLAIMABLE_AGENT_STATUS_SQL_LIST})`).run(at,id,staleBefore); return r.changes ? this.getById(id) : undefined; }
  async clearRun(id: string) { this.db.prepare('UPDATE tasks SET run_requested_at=NULL, run_claimed_at=NULL WHERE id=?').run(id); return this.getById(id); }
  async getPendingRuns(staleBefore = Date.now()-30_000) { return (this.db.prepare("SELECT * FROM tasks WHERE assigned_worker_id IS NULL AND run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < ?) AND agent_status IN ('idle','planning') ORDER BY run_requested_at").all(staleBefore) as TaskRow[]).map(rowToTask); }

  async assignToWorker(id: string, workerId: string | null): Promise<Task | undefined> {
    const result = this.db.prepare(`UPDATE tasks SET assigned_worker_id = ?, worker_claim_token_hash = NULL, worker_claimed_at = NULL, worker_lease_expires_at = NULL WHERE id = ? AND worker_claim_token_hash IS NULL AND agent_status IN ('idle','planning')`).run(workerId, id);
    return result.changes ? this.getById(id) : undefined;
  }

  async getWorkerAssignments(workerId: string, now: number): Promise<Task[]> {
    return (this.db.prepare(`SELECT * FROM tasks WHERE assigned_worker_id = ? AND run_requested_at IS NOT NULL AND agent_status IN ('idle','planning') AND (worker_claim_token_hash IS NULL OR worker_lease_expires_at < ?) ORDER BY run_requested_at`).all(workerId, now) as TaskRow[]).map(rowToTask);
  }

  async claimWorkerTask(id: string, workerId: string, claimTokenHash: string, now: number, leaseMs: number): Promise<Task | undefined> {
    const result = this.db.prepare(`UPDATE tasks SET worker_claim_token_hash = ?, worker_claimed_at = ?, worker_lease_expires_at = ?, worker_attempt = worker_attempt + 1, agent_status = 'planning', started_at = COALESCE(started_at, ?) WHERE id = ? AND assigned_worker_id = ? AND run_requested_at IS NOT NULL AND worker_claim_token_hash IS NULL AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at < ?) AND agent_status IN ('idle','planning')`).run(claimTokenHash, now, now + leaseMs, now, id, workerId, now);
    return result.changes ? this.getById(id) : undefined;
  }

  async renewWorkerLease(id: string, workerId: string, claimTokenHash: string, now: number, leaseMs: number): Promise<boolean> {
    const result = this.db.prepare('UPDATE tasks SET worker_lease_expires_at = ? WHERE id = ? AND assigned_worker_id = ? AND worker_claim_token_hash = ? AND worker_lease_expires_at >= ?').run(now + leaseMs, id, workerId, claimTokenHash, now);
    return result.changes > 0;
  }

  async isWorkerClaimValid(id: string, workerId: string, claimTokenHash: string, now: number): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 AS valid FROM tasks WHERE id = ? AND assigned_worker_id = ? AND worker_claim_token_hash = ? AND worker_lease_expires_at >= ?').get(id, workerId, claimTokenHash, now) as { valid: number } | undefined;
    return row?.valid === 1;
  }

  async completeWorkerTask(id: string, workerId: string, claimTokenHash: string, status: 'complete' | 'failed', completedAt: number, summary?: string, error?: string): Promise<Task | undefined> {
    const result = this.db.prepare(`UPDATE tasks SET agent_status = ?, completed_at = ?, summary = ?, run_claimed_at = NULL, worker_lease_expires_at = NULL WHERE id = ? AND assigned_worker_id = ? AND worker_claim_token_hash = ? AND worker_lease_expires_at >= ?`).run(status, completedAt, summary ?? (error ? error : null), id, workerId, claimTokenHash, completedAt);
    return result.changes ? this.getById(id) : undefined;
  }

  async getExpiredWorkerTasks(now: number): Promise<Task[]> {
    return (this.db.prepare(`SELECT * FROM tasks WHERE assigned_worker_id IS NOT NULL AND worker_lease_expires_at IS NOT NULL AND worker_lease_expires_at < ? AND agent_status IN ('planning','executing')`).all(now) as TaskRow[]).map(rowToTask);
  }

  async getAssignedWorkerTasks(workerIds: readonly string[]): Promise<Task[]> {
    if (workerIds.length === 0) return [];
    const placeholders = workerIds.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM tasks WHERE assigned_worker_id IN (${placeholders}) AND agent_status IN ('planning','executing')`).all(...workerIds) as TaskRow[]).map(rowToTask);
  }

  async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    return this.db.transaction(() => {
      const row = this.stmts.getById.get(id) as TaskRow | undefined;
      const existing = row ? rowToTask(row) : undefined;
      if (!existing) return undefined;
      const merged = { ...existing, ...updates };
      this.stmts.update.run({
        id,
        title: merged.title,
        description: merged.description,
        priority: merged.priority,
        column_id: merged.columnId,
        agent_status: merged.agentStatus,
        agent_type: merged.agentType,
        started_at: merged.startedAt ?? null,
        completed_at: merged.completedAt ?? null,
        repo_path: merged.repoPath ?? null,
        branch_name: merged.branchName ?? null,
        base_branch: merged.baseBranch ?? null,
        use_worktree: merged.useWorktree != null ? (merged.useWorktree ? 1 : 0) : null,
        worktree_path: merged.worktreePath ?? null,
        archived: merged.archived ? 1 : 0,
        summary: merged.summary ?? null, run_requested_at: merged.runRequestedAt ?? null, run_claimed_at: merged.runClaimedAt ?? null,
        timeout_minutes: merged.timeoutMinutes ?? null,
        clarification_request: merged.clarificationRequest ? JSON.stringify(merged.clarificationRequest) : null,
          clarification_answer: merged.clarificationAnswer ? JSON.stringify(merged.clarificationAnswer) : null,
           assigned_worker_id: merged.assignedWorkerId ?? null,
           worker_attempt: 0,
           labels: JSON.stringify(merged.labels ?? []),
           agent_preference: merged.agentPreference ?? null,
      });
      return merged;
    })();
  }

  async delete(id: string): Promise<boolean> {
    const result = this.stmts.delete.run(id);
    return result.changes > 0;
  }

  async count(): Promise<number> {
    const row = this.stmts.count.get() as { cnt: number };
    return row.cnt;
  }

  async insertEvent(event: AgentEvent): Promise<void> {
    this.stmts.insertEvent.run({
      id: event.id,
      task_id: event.taskId,
      type: event.type,
      content: event.content,
      timestamp: event.timestamp,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    });
  }

  async getEventsByTaskId(taskId: string): Promise<AgentEvent[]> {
    const rows = this.stmts.getEventsByTaskId.all(taskId) as Array<{
      id: string;
      task_id: string;
      type: string;
      content: string;
      timestamp: number;
      metadata: string | null;
    }>;
    return rows.map((row) => {
      let metadata: AgentEvent['metadata'] | undefined;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata);
        } catch (err: unknown) {
          // Log malformed metadata
          console.warn(`[sqlite] Failed to parse metadata for event ${row.id}:`, errorMessage(err));
        }
      }
      return {
        id: row.id,
        taskId: row.task_id,
        type: row.type as AgentEvent['type'],
        content: row.content,
        timestamp: row.timestamp,
        ...(metadata ? { metadata } : {}),
      };
    });
  }

  async deleteEventsByTaskId(taskId: string): Promise<void> {
    this.stmts.deleteEventsByTaskId.run(taskId);
  }

  async getArchivedTasks(projectId = 'default'): Promise<Task[]> {
    return (this.stmts.getArchived.all(projectId) as TaskRow[]).map(rowToTask);
  }
}
