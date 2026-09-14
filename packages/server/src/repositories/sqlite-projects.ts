import Database from 'better-sqlite3';
import type { AgentType, ColumnId, Priority, Project, ProjectTaskCounts } from '../types.js';
import type { ProjectRepository } from './project-types.js';
import { coerceOptionalAgentType } from '@ai-agent-board/shared/constants.js';

interface ProjectRow {
  id: string;
  name: string;
  repo_path: string | null;
  repo_url: string | null;
  is_default: number;
  created_at: number;
  updated_at: number;
  default_agent_type: string | null;
  default_priority: string | null;
  default_base_branch: string | null;
  default_use_worktree: number | null;
  aliases: string;
  jira_import_enabled: number;
  jira_import_interval_minutes: number;
  jira_import_auto_start: number;
  jira_import_last_run_at: number | null;
  jira_import_last_completed_at: number | null;
  jira_import_last_success_at: number | null;
  jira_import_last_error: string | null;
  jira_import_last_total: number | null;
  jira_import_last_created: number | null;
  jira_import_last_skipped: number | null;
}

interface CountRow {
  column_id: ColumnId;
  count: number;
}

function emptyCounts(): ProjectTaskCounts {
  return { backlog: 0, 'in-progress': 0, pending: 0, review: 0, done: 0, total: 0 };
}

function rowToProject(row: ProjectRow, taskCounts?: ProjectTaskCounts): Project {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repo_path ?? undefined,
    repoUrl: row.repo_url ?? undefined,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    defaultAgentType: coerceOptionalAgentType(row.default_agent_type),
    defaultPriority: (row.default_priority ?? undefined) as Priority | undefined,
    defaultBaseBranch: row.default_base_branch ?? undefined,
    defaultUseWorktree: row.default_use_worktree === null ? undefined : Boolean(row.default_use_worktree),
    aliases: JSON.parse(row.aliases || '[]'),
    jiraImportEnabled: Boolean(row.jira_import_enabled),
    jiraImportIntervalMinutes: row.jira_import_interval_minutes,
    jiraImportLastRunAt: row.jira_import_last_run_at ?? undefined,
    jiraImportLastCompletedAt: row.jira_import_last_completed_at ?? undefined,
    jiraImportLastSuccessAt: row.jira_import_last_success_at ?? undefined,
    jiraImportLastError: row.jira_import_last_error ?? undefined,
    jiraImportLastTotal: row.jira_import_last_total ?? undefined,
    jiraImportLastCreated: row.jira_import_last_created ?? undefined,
    jiraImportLastSkipped: row.jira_import_last_skipped ?? undefined,
    jiraImportAutoStart: Boolean(row.jira_import_auto_start),
    ...(taskCounts ? { taskCounts } : {}),
  };
}

export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly db: Database.Database) {}

  async getAllWithCounts(): Promise<Project[]> {
    const rows = this.db.prepare(`SELECT * FROM projects ORDER BY CASE WHEN id = 'default' THEN 0 ELSE 1 END, created_at ASC`).all() as ProjectRow[];
    return rows.map((row) => rowToProject(row, this.getCounts(row.id)));
  }

  async getById(id: string): Promise<Project | undefined> {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? rowToProject(row, this.getCounts(row.id)) : undefined;
  }

  async getDefault(): Promise<Project | undefined> {
    return this.getById('default');
  }

  async resolve(reference: string): Promise<Project[]> {
    const needle = reference.trim().toLowerCase();
    const rows = this.db.prepare('SELECT * FROM projects').all() as ProjectRow[];
    const exactId = rows.find((row) => row.id.toLowerCase() === needle);
    if (exactId) return [rowToProject(exactId, this.getCounts(exactId.id))];
    return rows.filter((row) => {
      const aliases = JSON.parse(row.aliases || '[]') as string[];
      return row.name.toLowerCase() === needle
        || aliases.some((alias) => alias.toLowerCase() === needle)
        || row.repo_path?.toLowerCase() === needle
        || row.repo_url?.replace(/\.git$/i, '').toLowerCase() === needle.replace(/\.git$/i, '');
    }).map((row) => rowToProject(row, this.getCounts(row.id)));
  }

  async create(input: {
    id: string;
    name: string;
    repoPath?: string;
    repoUrl?: string;
    defaultAgentType?: AgentType;
    defaultPriority?: Priority;
    defaultBaseBranch?: string;
    defaultUseWorktree?: boolean;
    aliases?: string[];
    jiraImportEnabled?: boolean;
    jiraImportIntervalMinutes?: number;
    jiraImportLastRunAt?: number;
    jiraImportLastCompletedAt?: number;
    jiraImportLastSuccessAt?: number;
    jiraImportLastError?: string;
    jiraImportLastTotal?: number;
    jiraImportLastCreated?: number;
    jiraImportLastSkipped?: number;
    jiraImportAutoStart?: boolean;
    createdAt: number;
    updatedAt: number;
  }): Promise<Project> {
    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO projects (id, name, repo_path, repo_url, is_default, created_at, updated_at,
          default_agent_type, default_priority, default_base_branch, default_use_worktree, aliases,
          jira_import_enabled, jira_import_interval_minutes, jira_import_auto_start, jira_import_last_run_at,
          jira_import_last_completed_at, jira_import_last_success_at, jira_import_last_error,
          jira_import_last_total, jira_import_last_created, jira_import_last_skipped)
        VALUES (@id, @name, @repo_path, @repo_url, @is_default, @created_at, @updated_at,
          @default_agent_type, @default_priority, @default_base_branch, @default_use_worktree, @aliases,
          @jira_import_enabled, @jira_import_interval_minutes, @jira_import_auto_start, @jira_import_last_run_at,
          @jira_import_last_completed_at, @jira_import_last_success_at, @jira_import_last_error,
          @jira_import_last_total, @jira_import_last_created, @jira_import_last_skipped)
      `).run({
        id: input.id,
        name: input.name,
        repo_path: input.repoPath ?? null,
        repo_url: input.repoUrl ?? null,
        is_default: 0,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
        default_agent_type: input.defaultAgentType ?? null,
        default_priority: input.defaultPriority ?? null,
        default_base_branch: input.defaultBaseBranch ?? null,
        default_use_worktree: input.defaultUseWorktree === undefined ? null : input.defaultUseWorktree ? 1 : 0,
        aliases: JSON.stringify(input.aliases ?? []),
        jira_import_enabled: input.jiraImportEnabled === true ? 1 : 0,
        jira_import_interval_minutes: input.jiraImportIntervalMinutes ?? 15,
        jira_import_auto_start: input.jiraImportAutoStart === true ? 1 : 0,
        jira_import_last_run_at: input.jiraImportLastRunAt ?? null,
        jira_import_last_completed_at: input.jiraImportLastCompletedAt ?? null,
        jira_import_last_success_at: input.jiraImportLastSuccessAt ?? null,
        jira_import_last_error: input.jiraImportLastError ?? null,
        jira_import_last_total: input.jiraImportLastTotal ?? null,
        jira_import_last_created: input.jiraImportLastCreated ?? null,
        jira_import_last_skipped: input.jiraImportLastSkipped ?? null,
      });
      const created = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(input.id) as ProjectRow;
      return rowToProject(created, this.getCounts(input.id));
    })();
  }

  async update(id: string, updates: {
    name?: string;
    repoPath?: string | null;
    repoUrl?: string | null;
    defaultAgentType?: AgentType | null;
    defaultPriority?: Priority | null;
    defaultBaseBranch?: string | null;
    defaultUseWorktree?: boolean | null;
    aliases?: string[];
    jiraImportEnabled?: boolean;
    jiraImportIntervalMinutes?: number;
    jiraImportLastRunAt?: number | null;
    jiraImportLastCompletedAt?: number | null;
    jiraImportLastSuccessAt?: number | null;
    jiraImportLastError?: string | null;
    jiraImportLastTotal?: number | null;
    jiraImportLastCreated?: number | null;
    jiraImportLastSkipped?: number | null;
    jiraImportAutoStart?: boolean;
    updatedAt: number;
  }): Promise<Project | undefined> {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
      if (!row) return undefined;
      const merged = {
        id,
        name: updates.name ?? row.name,
        repo_path: updates.repoPath === undefined ? row.repo_path : updates.repoPath,
        repo_url: updates.repoUrl === undefined ? row.repo_url : updates.repoUrl,
        is_default: row.is_default,
        updated_at: updates.updatedAt,
        default_agent_type: updates.defaultAgentType === undefined ? row.default_agent_type : updates.defaultAgentType,
        default_priority: updates.defaultPriority === undefined ? row.default_priority : updates.defaultPriority,
        default_base_branch: updates.defaultBaseBranch === undefined ? row.default_base_branch : updates.defaultBaseBranch,
        default_use_worktree: updates.defaultUseWorktree === undefined
          ? row.default_use_worktree
          : updates.defaultUseWorktree === null ? null : updates.defaultUseWorktree ? 1 : 0,
        aliases: updates.aliases === undefined ? row.aliases : JSON.stringify(updates.aliases),
        jira_import_enabled: updates.jiraImportEnabled === undefined ? row.jira_import_enabled : updates.jiraImportEnabled ? 1 : 0,
        jira_import_auto_start: updates.jiraImportAutoStart === undefined ? row.jira_import_auto_start : updates.jiraImportAutoStart ? 1 : 0,
        jira_import_interval_minutes: updates.jiraImportIntervalMinutes ?? row.jira_import_interval_minutes,
        jira_import_last_run_at: updates.jiraImportLastRunAt === undefined ? row.jira_import_last_run_at : updates.jiraImportLastRunAt,
        jira_import_last_completed_at: updates.jiraImportLastCompletedAt === undefined ? row.jira_import_last_completed_at : updates.jiraImportLastCompletedAt,
        jira_import_last_success_at: updates.jiraImportLastSuccessAt === undefined ? row.jira_import_last_success_at : updates.jiraImportLastSuccessAt,
        jira_import_last_error: updates.jiraImportLastError === undefined ? row.jira_import_last_error : updates.jiraImportLastError,
        jira_import_last_total: updates.jiraImportLastTotal === undefined ? row.jira_import_last_total : updates.jiraImportLastTotal,
        jira_import_last_created: updates.jiraImportLastCreated === undefined ? row.jira_import_last_created : updates.jiraImportLastCreated,
        jira_import_last_skipped: updates.jiraImportLastSkipped === undefined ? row.jira_import_last_skipped : updates.jiraImportLastSkipped,
      };
      this.db.prepare(`
        UPDATE projects
        SET name = @name, repo_path = @repo_path, repo_url = @repo_url, is_default = @is_default, updated_at = @updated_at,
          default_agent_type = @default_agent_type, default_priority = @default_priority,
          default_base_branch = @default_base_branch, default_use_worktree = @default_use_worktree, aliases = @aliases,
          jira_import_enabled = @jira_import_enabled, jira_import_interval_minutes = @jira_import_interval_minutes, jira_import_auto_start = @jira_import_auto_start,
          jira_import_last_run_at = @jira_import_last_run_at, jira_import_last_completed_at = @jira_import_last_completed_at,
          jira_import_last_success_at = @jira_import_last_success_at, jira_import_last_error = @jira_import_last_error,
          jira_import_last_total = @jira_import_last_total, jira_import_last_created = @jira_import_last_created,
          jira_import_last_skipped = @jira_import_last_skipped
        WHERE id = @id
      `).run(merged);
      const updated = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
      return rowToProject(updated, this.getCounts(id));
    })();
  }

  async hasTasksOrGroups(id: string): Promise<boolean> {
    const taskCount = (this.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?').get(id) as { count: number }).count;
    if (taskCount > 0) return true;
    const groupCount = (this.db.prepare('SELECT COUNT(*) AS count FROM task_groups WHERE project_id = ?').get(id) as { count: number }).count;
    return groupCount > 0;
  }

  async delete(id: string): Promise<boolean> {
    if (id === 'default') return false;
    return this.db.transaction(() => {
      const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
      if (!project) return false;
      // Cascade: delete tasks (their events cascade via FK, and group children share
      // project_id so they are removed too), then groups, then the project itself.
      this.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM task_groups WHERE project_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      if (project.is_default) {
        this.db.prepare('UPDATE projects SET is_default = 1 WHERE id = ?').run('default');
      }
      return result.changes > 0;
    })();
  }

  private getCounts(projectId: string): ProjectTaskCounts {
    const counts = emptyCounts();
    const taskRows = this.db.prepare(`
      SELECT column_id, COUNT(*) AS count
      FROM tasks
      WHERE project_id = ? AND archived = 0 AND group_id IS NULL
      GROUP BY column_id
    `).all(projectId) as CountRow[];
    const groupRows = this.db.prepare(`
      SELECT column_id, COUNT(*) AS count
      FROM task_groups
      WHERE project_id = ? AND archived = 0
      GROUP BY column_id
    `).all(projectId) as CountRow[];
    for (const row of [...taskRows, ...groupRows]) {
      counts[row.column_id] += row.count;
      counts.total += row.count;
    }
    return counts;
  }
}
