import type { Pool } from 'pg';
import type { Worker } from '../types.js';
import type {
  RegisteredWorkerOpenCodeSession,
  WorkerRegistration,
  WorkerRepository,
  WorkerTaskCommand,
} from './worker-types.js';
import { coerceAgentType } from '@ai-agent-board/shared/constants.js';

interface WorkerRow { id: string; name: string; token_hash: string; status: Worker['status']; hostname: string | null; version: string | null; agent_types_json: string; max_concurrent_tasks: number; registered_at: string; last_heartbeat_at: string; updated_at: string; disabled_at: string | null }
interface WorkerTaskSessionRow { session_id: string; base_url: string; updated_at: string }
interface WorkerTaskCommandRow {
  id: string;
  type: WorkerTaskCommand['type'];
  created_at: string;
  message: string | null;
  attachment_ids_json: string | null;
  request_id: string | null;
  session_id: string | null;
  answer: string | null;
}

function rowToWorker(row: WorkerRow): Worker & { readonly tokenHash: string } {
  return { id: row.id, name: row.name, status: row.status, agentTypes: (JSON.parse(row.agent_types_json) as unknown[]).map(coerceAgentType), hostname: row.hostname ?? undefined, version: row.version ?? undefined, maxConcurrentTasks: row.max_concurrent_tasks, registeredAt: Number(row.registered_at), lastHeartbeatAt: Number(row.last_heartbeat_at), updatedAt: Number(row.updated_at), tokenHash: row.token_hash };
}

function rowToTaskSession(row: WorkerTaskSessionRow): RegisteredWorkerOpenCodeSession {
  return {
    sessionId: row.session_id,
    baseUrl: row.base_url,
    updatedAt: Number(row.updated_at),
  };
}

function rowToTaskCommand(row: WorkerTaskCommandRow): WorkerTaskCommand {
  const attachmentIds = row.attachment_ids_json
    ? (JSON.parse(row.attachment_ids_json) as unknown[]).filter((value): value is string => typeof value === 'string')
    : undefined;
  return {
    id: row.id,
    type: row.type,
    createdAt: Number(row.created_at),
    ...(row.message ? { message: row.message } : {}),
    ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.answer ? { answer: row.answer } : {}),
  };
}

export class PostgresWorkerRepository implements WorkerRepository {
  constructor(private readonly pool: Pool) {}

  async register(input: WorkerRegistration): Promise<Worker> {
    await this.pool.query(`INSERT INTO workers (id,name,token_hash,status,hostname,version,agent_types_json,max_concurrent_tasks,registered_at,last_heartbeat_at,updated_at) VALUES ($1,$2,$3,'online',$4,$5,$6,$7,$8,$8,$8)`, [input.id, input.name, input.tokenHash, input.hostname ?? null, input.version ?? null, JSON.stringify(input.agentTypes), input.maxConcurrentTasks, input.registeredAt]);
    return (await this.getById(input.id)) as Worker;
  }

  async heartbeat(id: string, at: number): Promise<Worker | undefined> {
    await this.pool.query(`UPDATE workers SET status='online', last_heartbeat_at=$1, updated_at=$1 WHERE id=$2 AND status <> 'disabled'`, [at, id]);
    return this.getById(id);
  }

  async getById(id: string): Promise<Worker | undefined> {
    const { rows } = await this.pool.query<WorkerRow>('SELECT * FROM workers WHERE id=$1', [id]);
    return rows[0] ? rowToWorker(rows[0]) : undefined;
  }

  async getByTokenHash(tokenHash: string): Promise<(Worker & { readonly tokenHash: string }) | undefined> {
    const { rows } = await this.pool.query<WorkerRow>('SELECT * FROM workers WHERE token_hash=$1', [tokenHash]);
    return rows[0] ? rowToWorker(rows[0]) : undefined;
  }

  async list(): Promise<Worker[]> {
    const { rows } = await this.pool.query<WorkerRow>('SELECT * FROM workers ORDER BY name');
    return rows.map(rowToWorker);
  }

  async markOffline(cutoff: number, at: number): Promise<Worker[]> {
    const { rows } = await this.pool.query<WorkerRow>(`UPDATE workers SET status='offline', updated_at=$1 WHERE status='online' AND last_heartbeat_at < $2 RETURNING *`, [at, cutoff]);
    return rows.map(rowToWorker);
  }

  async registerTaskSession(taskId: string, sessionId: string, baseUrl: string, updatedAt: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker_task_sessions (task_id, session_id, base_url, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (task_id, session_id)
       DO UPDATE SET base_url = excluded.base_url, updated_at = excluded.updated_at`,
      [taskId, sessionId, baseUrl, updatedAt],
    );
  }

  async getTaskSessions(taskId: string): Promise<readonly RegisteredWorkerOpenCodeSession[]> {
    const { rows } = await this.pool.query<WorkerTaskSessionRow>(
      `SELECT session_id, base_url, updated_at
       FROM worker_task_sessions
       WHERE task_id = $1
       ORDER BY updated_at DESC, session_id ASC`,
      [taskId],
    );
    return rows.map(rowToTaskSession);
  }

  async enqueueTaskCommand(taskId: string, command: WorkerTaskCommand): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker_task_commands (
         id, task_id, type, created_at, message, attachment_ids_json, request_id, session_id, answer
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        command.id,
        taskId,
        command.type,
        command.createdAt,
        command.message ?? null,
        command.attachmentIds ? JSON.stringify(command.attachmentIds) : null,
        command.requestId ?? null,
        command.sessionId ?? null,
        command.answer ?? null,
      ],
    );
  }

  async claimTaskCommands(taskId: string, limit: number): Promise<readonly WorkerTaskCommand[]> {
    const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : 20;
    const { rows } = await this.pool.query<WorkerTaskCommandRow>(
      `WITH claimed AS (
         SELECT id
         FROM worker_task_commands
         WHERE task_id = $1
         ORDER BY created_at ASC, id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       ),
       deleted AS (
         DELETE FROM worker_task_commands commands
         WHERE commands.id IN (SELECT id FROM claimed)
         RETURNING
           commands.id,
           commands.type,
           commands.created_at,
           commands.message,
           commands.attachment_ids_json,
           commands.request_id,
           commands.session_id,
           commands.answer
       )
       SELECT * FROM deleted
       ORDER BY created_at ASC, id ASC`,
      [taskId, boundedLimit],
    );
    return rows.map(rowToTaskCommand);
  }

  async clearTaskCommands(taskId: string): Promise<void> {
    await this.pool.query('DELETE FROM worker_task_commands WHERE task_id = $1', [taskId]);
  }
}
