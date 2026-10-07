import type { Pool } from 'pg';
import type { A2AAgent, A2AAgentProjectAccess, A2ASkill, A2AWorkflowRole } from '../types.js';
import type { A2AAgentRepository, RegisterA2AAgentInput } from './a2a-agent-types.js';

interface AgentRow { id: string; agent_card_url: string; name: string; description: string; version: string; endpoint: string; protocol_version: string; skills_json: string; enabled: boolean; created_at: string; updated_at: string; last_validated_at: string; last_validation_error: string | null; }
interface AccessRow { agent_id: string; project_id: string; roles_json: string; created_at: string; updated_at: string; }
function skills(value: string): A2ASkill[] { try { return JSON.parse(value) as A2ASkill[]; } catch { return []; } }
function roles(value: string): A2AWorkflowRole[] { try { return (JSON.parse(value) as unknown[]).filter((role): role is A2AWorkflowRole => role === 'implementation' || role === 'review'); } catch { return []; } }
function normalizedRoles(value: readonly A2AWorkflowRole[]): A2AWorkflowRole[] { return [...new Set(value.filter((role) => role === 'implementation' || role === 'review'))]; }

export class PostgresA2AAgentRepository implements A2AAgentRepository {
  constructor(private readonly pool: Pool) {}
  async getAll(): Promise<A2AAgent[]> { const { rows } = await this.pool.query<AgentRow>('SELECT * FROM a2a_agents ORDER BY created_at ASC'); return Promise.all(rows.map((row) => this.toAgent(row))); }
  async getById(id: string): Promise<A2AAgent | undefined> { const { rows } = await this.pool.query<AgentRow>('SELECT * FROM a2a_agents WHERE id = $1', [id]); return rows[0] ? this.toAgent(rows[0]) : undefined; }
  async register(input: RegisterA2AAgentInput): Promise<A2AAgent> {
    await this.pool.query(`INSERT INTO a2a_agents (id, agent_card_url, name, description, version, endpoint, protocol_version, skills_json, enabled, created_at, updated_at, last_validated_at, last_validation_error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10,NULL)`, [input.id, input.agentCardUrl, input.name, input.description, input.version, input.endpoint, input.protocolVersion, JSON.stringify(input.skills), input.enabled, input.now]);
    return (await this.getById(input.id))!;
  }
  async setEnabled(id: string, enabled: boolean, now: number): Promise<A2AAgent | undefined> { await this.pool.query('UPDATE a2a_agents SET enabled = $1, updated_at = $2 WHERE id = $3', [enabled, now, id]); return this.getById(id); }
  async setProjectRoles(id: string, projectId: string, inputRoles: readonly A2AWorkflowRole[], now: number): Promise<A2AAgent | undefined> {
    if (!(await this.getById(id))) return undefined;
    const value = normalizedRoles(inputRoles);
    if (value.length === 0) await this.pool.query('DELETE FROM a2a_agent_project_roles WHERE agent_id = $1 AND project_id = $2', [id, projectId]);
    else await this.pool.query(`INSERT INTO a2a_agent_project_roles (agent_id, project_id, roles_json, created_at, updated_at) VALUES ($1,$2,$3,$4,$4) ON CONFLICT(agent_id, project_id) DO UPDATE SET roles_json = EXCLUDED.roles_json, updated_at = EXCLUDED.updated_at`, [id, projectId, JSON.stringify(value), now]);
    return this.getById(id);
  }
  async recordRefreshFailure(id: string, error: string, now: number): Promise<A2AAgent | undefined> { await this.pool.query('UPDATE a2a_agents SET last_validation_error = $1, updated_at = $2 WHERE id = $3', [error, now, id]); return this.getById(id); }
  async refresh(id: string, input: Omit<RegisterA2AAgentInput, 'id' | 'agentCardUrl' | 'enabled' | 'now'> & { now: number }): Promise<A2AAgent | undefined> { await this.pool.query('UPDATE a2a_agents SET name=$1, description=$2, version=$3, endpoint=$4, protocol_version=$5, skills_json=$6, updated_at=$7, last_validated_at=$7, last_validation_error=NULL WHERE id=$8', [input.name, input.description, input.version, input.endpoint, input.protocolVersion, JSON.stringify(input.skills), input.now, id]); return this.getById(id); }
  async delete(id: string): Promise<boolean> { return (await this.pool.query('DELETE FROM a2a_agents WHERE id = $1', [id])).rowCount === 1; }
  private async toAgent(row: AgentRow): Promise<A2AAgent> { const { rows } = await this.pool.query<AccessRow>('SELECT * FROM a2a_agent_project_roles WHERE agent_id = $1 ORDER BY project_id ASC', [row.id]); const projectAccess: A2AAgentProjectAccess[] = rows.map((access) => ({ agentId: access.agent_id, projectId: access.project_id, roles: roles(access.roles_json), createdAt: Number(access.created_at), updatedAt: Number(access.updated_at) })); return { id: row.id, agentCardUrl: row.agent_card_url, name: row.name, description: row.description, version: row.version, endpoint: row.endpoint, protocolVersion: row.protocol_version, skills: skills(row.skills_json), enabled: row.enabled, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), lastValidatedAt: Number(row.last_validated_at), ...(row.last_validation_error ? { lastValidationError: row.last_validation_error } : {}), projectAccess }; }
}
