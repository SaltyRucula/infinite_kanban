import Database from 'better-sqlite3';
import type { Worker } from '../types.js';
import type {
  RegisteredWorkerOpenCodeSession,
  WorkerRegistration,
  WorkerRepository,
  WorkerTaskCommand,
} from './worker-types.js';
import { coerceAgentType } from '@ai-agent-board/shared/constants.js';

interface WorkerRow { id: string; name: string; token_hash: string; status: Worker['status']; hostname: string | null; version: string | null; agent_types_json: string; max_concurrent_tasks: number; registered_at: number; last_heartbeat_at: number; updated_at: number; disabled_at: number | null }
interface WorkerTaskSessionRow { session_id: string; base_url: string; updated_at: number }
interface WorkerTaskCommandRow {
  id: string;
  type: WorkerTaskCommand['type'];
  created_at: number;
  message: string | null;
  attachment_ids_json: string | null;
  request_id: string | null;
  session_id: string | null;
  answer: string | null;
}

function rowToWorker(row: WorkerRow): Worker & { readonly tokenHash: string } {
  return { id: row.id, name: row.name, status: row.status, agentTypes: (JSON.parse(row.agent_types_json) as unknown[]).map(coerceAgentType), hostname: row.hostname ?? undefined, version: row.version ?? undefined, maxConcurrentTasks: row.max_concurrent_tasks, registeredAt: row.registered_at, lastHeartbeatAt: row.last_heartbeat_at, updatedAt: row.updated_at, tokenHash: row.token_hash };
}

function rowToTaskSession(row: WorkerTaskSessionRow): RegisteredWorkerOpenCodeSession {
  return {
    sessionId: row.session_id,
    baseUrl: row.base_url,
    updatedAt: row.updated_at,
  };
}

function rowToTaskCommand(row: WorkerTaskCommandRow): WorkerTaskCommand {
  const attachmentIds = row.attachment_ids_json
    ? (JSON.parse(row.attachment_ids_json) as unknown[]).filter((value): value is string => typeof value === 'string')
    : undefined;
  return {
    id: row.id,
    type: row.type,
    createdAt: row.created_at,
    ...(row.message ? { message: row.message } : {}),
    ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.answer ? { answer: row.answer } : {}),
  };
}

export class SqliteWorkerRepository implements WorkerRepository {
  constructor(private readonly db: Database.Database) {}

  async register(input: WorkerRegistration): Promise<Worker> {
    this.db.prepare(`INSERT INTO workers (id,name,token_hash,status,hostname,version,agent_types_json,max_concurrent_tasks,registered_at,last_heartbeat_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.name, input.tokenHash, 'online', input.hostname ?? null, input.version ?? null, JSON.stringify(input.agentTypes), input.maxConcurrentTasks, input.registeredAt, input.registeredAt, input.registeredAt);
    return this.getById(input.id) as Promise<Worker>;
  }

  async heartbeat(id: string, at: number): Promise<Worker | undefined> {
    this.db.prepare(`UPDATE workers SET status='online', last_heartbeat_at=?, updated_at=? WHERE id=? AND status <> 'disabled'`).run(at, at, id);
    return this.getById(id);
  }

  async getById(id: string): Promise<Worker | undefined> {
    const row = this.db.prepare('SELECT * FROM workers WHERE id=?').get(id) as WorkerRow | undefined;
    return row ? rowToWorker(row) : undefined;
  }

  async getByTokenHash(tokenHash: string): Promise<(Worker & { readonly tokenHash: string }) | undefined> {
    const row = this.db.prepare('SELECT * FROM workers WHERE token_hash=?').get(tokenHash) as WorkerRow | undefined;
    return row ? rowToWorker(row) : undefined;
  }

  async list(): Promise<Worker[]> {
    return (this.db.prepare('SELECT * FROM workers ORDER BY name').all() as WorkerRow[]).map(rowToWorker);
  }

  async markOffline(cutoff: number, at: number): Promise<Worker[]> {
    const rows = this.db.prepare(`SELECT * FROM workers WHERE status='online' AND last_heartbeat_at < ?`).all(cutoff) as WorkerRow[];
    this.db.prepare(`UPDATE workers SET status='offline', updated_at=? WHERE status='online' AND last_heartbeat_at < ?`).run(at, cutoff);
    return rows.map((row) => ({ ...rowToWorker(row), status: 'offline' as const, updatedAt: at }));
  }

  async registerTaskSession(taskId: string, sessionId: string, baseUrl: string, updatedAt: number): Promise<void> {
    this.db.prepare(
      `INSERT INTO worker_task_sessions (task_id, session_id, base_url, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, session_id) DO UPDATE SET
         base_url = excluded.base_url,
         updated_at = excluded.updated_at`,
    ).run(taskId, sessionId, baseUrl, updatedAt);
  }

  async getTaskSessions(taskId: string): Promise<readonly RegisteredWorkerOpenCodeSession[]> {
    return (this.db
      .prepare('SELECT session_id, base_url, updated_at FROM worker_task_sessions WHERE task_id=? ORDER BY updated_at DESC, session_id ASC')
      .all(taskId) as WorkerTaskSessionRow[])
      .map(rowToTaskSession);
  }

  async clearTaskSessions(taskId: string): Promise<void> {
    this.db.prepare('DELETE FROM worker_task_sessions WHERE task_id=?').run(taskId);
  }

  async enqueueTaskCommand(taskId: string, command: WorkerTaskCommand): Promise<void> {
    this.db.prepare(
      `INSERT INTO worker_task_commands (
        id, task_id, type, created_at, message, attachment_ids_json, request_id, session_id, answer
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      command.id,
      taskId,
      command.type,
      command.createdAt,
      command.message ?? null,
      command.attachmentIds ? JSON.stringify(command.attachmentIds) : null,
      command.requestId ?? null,
      command.sessionId ?? null,
      command.answer ?? null,
    );
  }

  async claimTaskCommands(taskId: string, limit: number): Promise<readonly WorkerTaskCommand[]> {
    const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : 20;
    const claim = this.db.transaction((nextTaskId: string, nextLimit: number): WorkerTaskCommand[] => {
      const rows = this.db
        .prepare(
          `SELECT id, type, created_at, message, attachment_ids_json, request_id, session_id, answer
           FROM worker_task_commands
           WHERE task_id=?
           ORDER BY created_at ASC, id ASC
           LIMIT ?`,
        )
        .all(nextTaskId, nextLimit) as WorkerTaskCommandRow[];
      if (rows.length === 0) return [];

      const deleteCommand = this.db.prepare('DELETE FROM worker_task_commands WHERE id=?');
      for (const row of rows) {
        deleteCommand.run(row.id);
      }
      return rows.map(rowToTaskCommand);
    });
    return claim(taskId, boundedLimit);
  }

  async clearTaskCommands(taskId: string): Promise<void> {
    this.db.prepare('DELETE FROM worker_task_commands WHERE task_id=?').run(taskId);
  }
}
