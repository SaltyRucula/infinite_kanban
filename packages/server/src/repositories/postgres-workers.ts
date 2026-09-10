import type { Pool } from 'pg';
import type { AgentType, Worker } from '../types.js';
import type { WorkerRegistration, WorkerRepository } from './worker-types.js';

interface WorkerRow { id: string; name: string; token_hash: string; status: Worker['status']; hostname: string | null; version: string | null; agent_types_json: string; max_concurrent_tasks: number; registered_at: string; last_heartbeat_at: string; updated_at: string; disabled_at: string | null }

function rowToWorker(row: WorkerRow): Worker & { readonly tokenHash: string } {
  return { id: row.id, name: row.name, status: row.status, agentTypes: JSON.parse(row.agent_types_json) as AgentType[], hostname: row.hostname ?? undefined, version: row.version ?? undefined, maxConcurrentTasks: row.max_concurrent_tasks, registeredAt: Number(row.registered_at), lastHeartbeatAt: Number(row.last_heartbeat_at), updatedAt: Number(row.updated_at), tokenHash: row.token_hash };
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
}
