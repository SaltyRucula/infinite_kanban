import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';
import type { Pool } from 'pg';
import type { AgentType, Priority, Project } from '../src/types.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { TaskGroupRepository } from '../src/repositories/group-types.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import { createProjectsRouter } from '../src/routes/projects.js';
import { SqliteProjectRepository } from '../src/repositories/sqlite-projects.js';
import { PostgresProjectRepository } from '../src/repositories/postgres-projects.js';
import { initPostgresDatabase } from '../src/db.js';

type ProjectCreateInput = Parameters<ProjectRepository['create']>[0];
type ProjectUpdateInput = Parameters<ProjectRepository['update']>[1];

function buildProject(input: {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly repoPath?: string;
  readonly repoUrl?: string;
  readonly defaultAgentType?: AgentType;
  readonly defaultPriority?: Priority;
  readonly defaultBaseBranch?: string;
  readonly defaultUseWorktree?: boolean;
  readonly aliases?: string[];
  readonly jiraImportEnabled?: boolean;
  readonly jiraImportIntervalMinutes?: number;
  readonly jiraImportAutoStart?: boolean;
}): Project {
  return {
    id: input.id,
    name: input.name,
    isDefault: input.isDefault,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    repoPath: input.repoPath,
    repoUrl: input.repoUrl,
    defaultAgentType: input.defaultAgentType,
    defaultPriority: input.defaultPriority,
    defaultBaseBranch: input.defaultBaseBranch,
    defaultUseWorktree: input.defaultUseWorktree,
    aliases: input.aliases ?? [],
    jiraImportEnabled: input.jiraImportEnabled ?? false,
    jiraImportIntervalMinutes: input.jiraImportIntervalMinutes ?? 15,
    jiraImportAutoStart: input.jiraImportAutoStart ?? false,
  };
}

class RecordingProjectRepository implements ProjectRepository {
  public readonly createInputs: ProjectCreateInput[] = [];

  public readonly updateInputs: ProjectUpdateInput[] = [];

  private readonly projects = new Map<string, Project>();

  constructor(initialProjects: readonly Project[] = []) {
    for (const project of initialProjects) {
      this.projects.set(project.id, project);
    }
  }

  async getAllWithCounts(): Promise<Project[]> {
    return [...this.projects.values()];
  }

  async getById(id: string): Promise<Project | undefined> {
    return this.projects.get(id);
  }

  async getDefault(): Promise<Project | undefined> {
    return [...this.projects.values()].find((project) => project.isDefault);
  }

  async resolve(reference: string): Promise<Project[]> {
    return [...this.projects.values()].filter((project) => project.id === reference || project.name === reference);
  }

  async create(input: ProjectCreateInput): Promise<Project> {
    this.createInputs.push(input);
    const created = buildProject({
      id: input.id,
      name: input.name,
      isDefault: false,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      repoPath: input.repoPath,
      repoUrl: input.repoUrl,
      defaultAgentType: input.defaultAgentType,
      defaultPriority: input.defaultPriority,
      defaultBaseBranch: input.defaultBaseBranch,
      defaultUseWorktree: input.defaultUseWorktree,
      aliases: input.aliases,
      jiraImportEnabled: input.jiraImportEnabled,
      jiraImportIntervalMinutes: input.jiraImportIntervalMinutes,
      jiraImportAutoStart: input.jiraImportAutoStart,
    });
    this.projects.set(created.id, created);
    return created;
  }

  async update(id: string, updates: ProjectUpdateInput): Promise<Project | undefined> {
    const existing = this.projects.get(id);
    if (!existing) return undefined;
    this.updateInputs.push(updates);
    const updated: Project = {
      ...existing,
      name: updates.name ?? existing.name,
      repoPath: updates.repoPath === undefined ? existing.repoPath : updates.repoPath ?? undefined,
      repoUrl: updates.repoUrl === undefined ? existing.repoUrl : updates.repoUrl ?? undefined,
      jiraImportEnabled: updates.jiraImportEnabled ?? existing.jiraImportEnabled,
      jiraImportIntervalMinutes: updates.jiraImportIntervalMinutes ?? existing.jiraImportIntervalMinutes,
      jiraImportAutoStart: updates.jiraImportAutoStart ?? existing.jiraImportAutoStart,
      updatedAt: updates.updatedAt,
    };
    this.projects.set(id, updated);
    return updated;
  }

  async hasTasksOrGroups(): Promise<boolean> {
    return false;
  }

  async delete(): Promise<boolean> {
    return false;
  }
}

async function withProjectsApp(
  projectRepo: ProjectRepository,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', createProjectsRouter(
    projectRepo,
    {} as TaskRepository,
    {} as TaskGroupRepository,
    {} as AgentManager,
  ));

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind test server');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test('jira auto-start create and patch routes validate booleans and persist schedule fields', async () => {
  const projectRepo = new RecordingProjectRepository([
    buildProject({
      id: 'project-1',
      name: 'Project 1',
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
      jiraImportEnabled: true,
      jiraImportIntervalMinutes: 15,
      jiraImportAutoStart: false,
    }),
  ]);

  await withProjectsApp(projectRepo, async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Auto Start Project', jiraImportAutoStart: true }),
    });
    assert.equal(createResponse.status, 201);
    assert.equal(projectRepo.createInputs.at(-1)?.jiraImportAutoStart, true);

    const invalidCreateResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Invalid Auto Start', jiraImportAutoStart: 'true' }),
    });
    assert.equal(invalidCreateResponse.status, 400);
    assert.match(JSON.stringify(await invalidCreateResponse.json()), /jiraImportAutoStart must be a boolean/);

    const patchResponse = await fetch(`${baseUrl}/api/projects/project-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jiraImportAutoStart: true }),
    });
    assert.equal(patchResponse.status, 200);
    assert.equal(projectRepo.updateInputs.at(-1)?.jiraImportAutoStart, true);

    const invalidPatchResponse = await fetch(`${baseUrl}/api/projects/project-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jiraImportAutoStart: 1 }),
    });
    assert.equal(invalidPatchResponse.status, 400);
    assert.match(JSON.stringify(await invalidPatchResponse.json()), /jiraImportAutoStart must be a boolean/);
  });
});

test('jira auto-start sqlite project mapping round-trips default false and true opt-in', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_path TEXT,
      repo_url TEXT,
      is_default INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      default_agent_type TEXT,
      default_priority TEXT,
      default_base_branch TEXT,
      default_use_worktree INTEGER,
      aliases TEXT NOT NULL DEFAULT '[]',
      jira_import_enabled INTEGER NOT NULL DEFAULT 0,
      jira_import_interval_minutes INTEGER NOT NULL DEFAULT 15,
      jira_import_auto_start INTEGER NOT NULL DEFAULT 0,
      jira_import_last_run_at INTEGER,
      jira_import_last_completed_at INTEGER,
      jira_import_last_success_at INTEGER,
      jira_import_last_error TEXT,
      jira_import_last_total INTEGER,
      jira_import_last_created INTEGER,
      jira_import_last_skipped INTEGER
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      column_id TEXT NOT NULL,
      archived INTEGER NOT NULL,
      group_id TEXT
    );
    CREATE TABLE task_groups (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      column_id TEXT NOT NULL,
      archived INTEGER NOT NULL
    );
  `);

  try {
    const repo = new SqliteProjectRepository(db);
    const created = await repo.create({
      id: 'sqlite-project',
      name: 'SQLite Project',
      createdAt: 1,
      updatedAt: 1,
    });
    assert.equal(created.jiraImportAutoStart, false);

    await repo.update('sqlite-project', {
      jiraImportAutoStart: true,
      updatedAt: 2,
    });

    const updated = await repo.getById('sqlite-project');
    assert.equal(updated?.jiraImportAutoStart, true);
  } finally {
    db.close();
  }
});

test('jira auto-start postgres project mapping reads boolean field from project rows', async () => {
  const projectRow = {
    id: 'postgres-project',
    name: 'Postgres Project',
    repo_path: null,
    repo_url: null,
    is_default: false,
    created_at: '1',
    updated_at: '2',
    default_agent_type: null,
    default_priority: null,
    default_base_branch: null,
    default_use_worktree: null,
    aliases: '[]',
    jira_import_enabled: false,
    jira_import_interval_minutes: 15,
    jira_import_auto_start: true,
    jira_import_last_run_at: null,
    jira_import_last_completed_at: null,
    jira_import_last_success_at: null,
    jira_import_last_error: null,
    jira_import_last_total: null,
    jira_import_last_created: null,
    jira_import_last_skipped: null,
  };

  const pool = {
    async query<T>(queryText: string): Promise<{ rows: T[] }> {
      if (queryText.includes('SELECT * FROM projects WHERE id = $1')) {
        return { rows: [projectRow as T] };
      }
      return { rows: [] };
    },
  } as Pick<Pool, 'query'>;

  const repo = new PostgresProjectRepository(pool as Pool);
  const project = await repo.getById('postgres-project');
  assert.equal(project?.jiraImportAutoStart, true);
});

test('jira auto-start postgres migration adds a default-false column', async () => {
  const executedSql: string[] = [];
  const pool = {
    async query(queryText: string): Promise<{ rows: Array<{ column_name: string } | { delete_rule: string } | { constraint_name: string }> }> {
      executedSql.push(queryText);
      if (queryText.includes("table_name = 'projects'")) {
        return { rows: [] };
      }
      if (queryText.includes("table_name = 'tasks'")) {
        return { rows: [] };
      }
      if (queryText.includes("table_name = 'task_groups'")) {
        return { rows: [] };
      }
      if (queryText.includes('information_schema.table_constraints')) {
        return { rows: [] };
      }
      if (queryText.includes('information_schema.referential_constraints')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  } as Pick<Pool, 'query'>;

  await initPostgresDatabase(pool as Pool);

  assert.ok(
    executedSql.some((sql) => sql.includes('ADD COLUMN jira_import_auto_start BOOLEAN NOT NULL DEFAULT FALSE')),
    'expected postgres migration to add jira_import_auto_start with a default false value',
  );
});

test('jira auto-start sqlite migration backfills false for legacy projects', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'jira-auto-start-'));
  const dbPath = path.join(tempDir, 'legacy.db');
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_path TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO projects (id, name, repo_path, is_default, created_at, updated_at)
    VALUES ('legacy-project', 'Legacy', NULL, 0, 1, 1);
  `);
  legacyDb.close();

  const originalDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  try {
    const { initDatabase } = await import(`../src/db.js?jira-auto-start=${Date.now()}-${Math.random()}`);
    const migrated = initDatabase();
    const row = migrated.prepare('SELECT jira_import_auto_start FROM projects WHERE id = ?').get('legacy-project') as { jira_import_auto_start: number };
    assert.equal(row.jira_import_auto_start, 0);
    migrated.close();
  } finally {
    if (originalDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = originalDbPath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});
