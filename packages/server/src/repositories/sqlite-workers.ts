import Database from 'better-sqlite3';
import type { AgentType, Worker } from '../types.js';
import type { WorkerRegistration, WorkerRepository } from './worker-types.js';

interface WorkerRow { id: string; name: string; token_hash: string; status: Worker['status']; hostname: string | null; version: string | null; agent_types_json: string; max_concurrent_tasks: number; registered_at: number; last_heartbeat_at: number; updated_at: number; disabled_at: number | null }

function rowToWorker(row: WorkerRow): Worker & { readonly tokenHash: string } {
  return { id: row.id, name: row.name, status: row.status, agentTypes: JSON.parse(row.agent_types_json) as AgentType[], hostname: row.hostname ?? undefined, version: row.version ?? undefined, maxConcurrentTasks: row.max_concurrent_tasks, registeredAt: row.registered_at, lastHeartbeatAt: row.last_heartbeat_at, updatedAt: row.updated_at, tokenHash: row.token_hash };
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
}
