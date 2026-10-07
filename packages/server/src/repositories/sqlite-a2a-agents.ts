import Database from 'better-sqlite3';
import type { A2AAgent, A2AAgentProjectAccess, A2ASkill, A2AWorkflowRole } from '../types.js';
import type { A2AAgentRepository, RegisterA2AAgentInput } from './a2a-agent-types.js';

interface AgentRow {
  id: string; agent_card_url: string; name: string; description: string; version: string;
  endpoint: string; protocol_version: string; skills_json: string; enabled: number;
  created_at: number; updated_at: number; last_validated_at: number; last_validation_error: string | null;
}
interface AccessRow { agent_id: string; project_id: string; roles_json: string; created_at: number; updated_at: number; }

function parseSkills(value: string): A2ASkill[] { try { return JSON.parse(value) as A2ASkill[]; } catch { return []; } }
function parseRoles(value: string): A2AWorkflowRole[] {
  try { return (JSON.parse(value) as unknown[]).filter((role): role is A2AWorkflowRole => role === 'implementation' || role === 'review'); } catch { return []; }
}
function normalizeRoles(roles: readonly A2AWorkflowRole[]): A2AWorkflowRole[] { return [...new Set(roles.filter((role) => role === 'implementation' || role === 'review'))]; }

export class SqliteA2AAgentRepository implements A2AAgentRepository {
  constructor(private readonly db: Database.Database) {}

  async getAll(): Promise<A2AAgent[]> { return (this.db.prepare('SELECT * FROM a2a_agents ORDER BY created_at ASC').all() as AgentRow[]).map((row) => this.toAgent(row)); }
  async getById(id: string): Promise<A2AAgent | undefined> { const row = this.db.prepare('SELECT * FROM a2a_agents WHERE id = ?').get(id) as AgentRow | undefined; return row ? this.toAgent(row) : undefined; }

  async register(input: RegisterA2AAgentInput): Promise<A2AAgent> {
    this.db.prepare(`INSERT INTO a2a_agents (id, agent_card_url, name, description, version, endpoint, protocol_version, skills_json, enabled, created_at, updated_at, last_validated_at, last_validation_error)
      VALUES (@id, @agentCardUrl, @name, @description, @version, @endpoint, @protocolVersion, @skillsJson, @enabled, @now, @now, @now, NULL)`).run({ ...input, skillsJson: JSON.stringify(input.skills), enabled: input.enabled ? 1 : 0 });
    return (await this.getById(input.id))!;
  }

  async setEnabled(id: string, enabled: boolean, now: number): Promise<A2AAgent | undefined> {
    this.db.prepare('UPDATE a2a_agents SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now, id);
    return this.getById(id);
  }

  async setProjectRoles(id: string, projectId: string, roles: readonly A2AWorkflowRole[], now: number): Promise<A2AAgent | undefined> {
    if (!(await this.getById(id))) return undefined;
    const normalized = normalizeRoles(roles);
    this.db.transaction(() => {
      if (normalized.length === 0) {
        this.db.prepare('DELETE FROM a2a_agent_project_roles WHERE agent_id = ? AND project_id = ?').run(id, projectId);
      } else {
        this.db.prepare(`INSERT INTO a2a_agent_project_roles (agent_id, project_id, roles_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(agent_id, project_id) DO UPDATE SET roles_json = excluded.roles_json, updated_at = excluded.updated_at`).run(id, projectId, JSON.stringify(normalized), now, now);
      }
    })();
    return this.getById(id);
  }

  async recordRefreshFailure(id: string, error: string, now: number): Promise<A2AAgent | undefined> {
    this.db.prepare('UPDATE a2a_agents SET last_validation_error = ?, updated_at = ? WHERE id = ?').run(error, now, id);
    return this.getById(id);
  }

  async refresh(id: string, input: Omit<RegisterA2AAgentInput, 'id' | 'agentCardUrl' | 'enabled' | 'now'> & { now: number }): Promise<A2AAgent | undefined> {
    this.db.prepare(`UPDATE a2a_agents SET name = @name, description = @description, version = @version, endpoint = @endpoint,
      protocol_version = @protocolVersion, skills_json = @skillsJson, updated_at = @now, last_validated_at = @now, last_validation_error = NULL WHERE id = @id`).run({ ...input, id, skillsJson: JSON.stringify(input.skills) });
    return this.getById(id);
  }

  async delete(id: string): Promise<boolean> { return this.db.prepare('DELETE FROM a2a_agents WHERE id = ?').run(id).changes > 0; }

  private toAgent(row: AgentRow): A2AAgent {
    const accessRows = this.db.prepare('SELECT * FROM a2a_agent_project_roles WHERE agent_id = ? ORDER BY project_id ASC').all(row.id) as AccessRow[];
    const projectAccess: A2AAgentProjectAccess[] = accessRows.map((access) => ({ agentId: access.agent_id, projectId: access.project_id, roles: parseRoles(access.roles_json), createdAt: access.created_at, updatedAt: access.updated_at }));
    return { id: row.id, agentCardUrl: row.agent_card_url, name: row.name, description: row.description, version: row.version, endpoint: row.endpoint, protocolVersion: row.protocol_version, skills: parseSkills(row.skills_json), enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at, lastValidatedAt: row.last_validated_at, ...(row.last_validation_error ? { lastValidationError: row.last_validation_error } : {}), projectAccess };
  }
}
