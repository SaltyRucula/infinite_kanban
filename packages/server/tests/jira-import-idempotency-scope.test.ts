import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { Pool } from 'pg';
import { initPostgresDatabase } from '../src/db.js';
import { importAssignedJiraIssues } from '../src/jira/importer.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import type { Project, Task } from '../src/types.js';
import type { JiraIssue } from '../src/jira/client.js';

function makeProject(projectId: string): Project {
  return {
    id: projectId,
    name: `Project ${projectId}`,
    isDefault: projectId === 'default',
    createdAt: 1,
    updatedAt: 1,
    defaultPriority: 'medium',
    defaultAgentType: 'copilot',
  };
}

function makeIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '10001',
    key: 'PROJ-1',
    summary: 'Scoped idempotency issue',
    description: 'Imported from Jira',
    status: 'To Do',
    issueType: 'Task',
    ...overrides,
  };
}

function makeExternalTask(input: {
  readonly id: string;
  readonly projectId: string;
  readonly externalSource: string;
  readonly externalKey: string;
}): Task {
  return {
    id: input.id,
    projectId: input.projectId,
    title: `Task ${input.id}`,
    description: '',
    priority: 'medium',
    columnId: 'backlog',
    agentStatus: 'idle',
    agentType: 'copilot',
    createdAt: 1,
    externalSource: input.externalSource,
    externalKey: input.externalKey,
  };
}

function insertProject(db: Database.Database, projectId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, repo_path, is_default, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?)
  `).run(projectId, `Project ${projectId}`, projectId === 'default' ? 1 : 0, 1, 1);
}

async function withFreshMigratedSqliteDb(
  run: (db: Database.Database) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'jira-project-scope-'));
  const dbPath = path.join(tempDir, 'board.db');
  const priorDbPath = process.env.DB_PATH;

  process.env.DB_PATH = dbPath;
  try {
    const { initDatabase } = await import(`../src/db.js?jira-project-scope=${Date.now()}-${Math.random()}`);
    const db = initDatabase();
    try {
      await run(db);
    } finally {
      db.close();
    }
  } finally {
    if (priorDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = priorDbPath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('Jira import idempotency is scoped per project and still deduplicates within the same project', async () => {
  await withFreshMigratedSqliteDb(async (db) => {
    insertProject(db, 'project-a');
    insertProject(db, 'project-b');
    const repo = new SqliteTaskRepository(db);
    const issues = [makeIssue()];

    const firstProjectAImport = await importAssignedJiraIssues({
      repo,
      project: makeProject('project-a'),
      issues,
      jiraBaseUrl: 'https://jira.example.com',
    });
    const firstProjectBImport = await importAssignedJiraIssues({
      repo,
      project: makeProject('project-b'),
      issues,
      jiraBaseUrl: 'https://jira.example.com',
    });
    const secondProjectAImport = await importAssignedJiraIssues({
      repo,
      project: makeProject('project-a'),
      issues,
      jiraBaseUrl: 'https://jira.example.com',
    });

    assert.equal(firstProjectAImport.created, 1);
    assert.equal(firstProjectAImport.skipped, 0);
    assert.equal(firstProjectBImport.created, 1);
    assert.equal(firstProjectBImport.skipped, 0);
    assert.equal(secondProjectAImport.created, 0);
    assert.equal(secondProjectAImport.skipped, 1);

    const projectATasks = await repo.getAll(true, 'project-a');
    const projectBTasks = await repo.getAll(true, 'project-b');
    assert.equal(projectATasks.length, 1);
    assert.equal(projectBTasks.length, 1);
    assert.equal(projectATasks[0].externalKey, projectBTasks[0].externalKey);
    assert.equal(projectATasks[0].projectId, 'project-a');
    assert.equal(projectBTasks[0].projectId, 'project-b');
    assert.equal(await repo.count(), 2);
  });
});

test('non-Jira external identity idempotency remains per-project', async () => {
  await withFreshMigratedSqliteDb(async (db) => {
    insertProject(db, 'project-a');
    insertProject(db, 'project-b');
    const repo = new SqliteTaskRepository(db);

    const firstInA = await repo.createIdempotent(makeExternalTask({
      id: 'task-a-1',
      projectId: 'project-a',
      externalSource: 'github',
      externalKey: 'issue-123',
    }));
    const duplicateInA = await repo.createIdempotent(makeExternalTask({
      id: 'task-a-2',
      projectId: 'project-a',
      externalSource: 'github',
      externalKey: 'issue-123',
    }));
    const firstInB = await repo.createIdempotent(makeExternalTask({
      id: 'task-b-1',
      projectId: 'project-b',
      externalSource: 'github',
      externalKey: 'issue-123',
    }));

    assert.equal(firstInA.created, true);
    assert.equal(duplicateInA.created, false);
    assert.equal(duplicateInA.task.id, 'task-a-1');
    assert.equal(firstInB.created, true);
    assert.equal(await repo.count(), 2);
  });
});

test('sqlite migration replaces legacy global external identity index with project-scoped unique index', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'jira-index-migration-sqlite-'));
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
    VALUES ('default', 'Default', NULL, 1, 1, 1);

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'medium',
      column_id TEXT NOT NULL DEFAULT 'backlog',
      agent_status TEXT NOT NULL DEFAULT 'idle',
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      project_id TEXT NOT NULL DEFAULT 'default',
      external_source TEXT,
      external_key TEXT
    );
    CREATE UNIQUE INDEX idx_tasks_external_identity
      ON tasks(external_source, external_key)
      WHERE external_source IS NOT NULL AND external_key IS NOT NULL;
  `);
  legacyDb.close();

  const priorDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  try {
    const { initDatabase } = await import(`../src/db.js?jira-index-migration-sqlite=${Date.now()}-${Math.random()}`);
    const migrated = initDatabase();
    const indexRow = migrated.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_tasks_external_identity'
    `).get() as { sql: string | null };
    assert.match(indexRow.sql ?? '', /\(project_id,\s*external_source,\s*external_key\)/i);
    migrated.close();
  } finally {
    if (priorDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = priorDbPath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres migration drops legacy global external identity index and recreates a project-scoped unique index', async () => {
  const executedSql: string[] = [];
  const pool = {
    async query(queryText: string): Promise<{ rows: Array<{ column_name: string } | { delete_rule: string } | { constraint_name: string } | { indexdef: string }> }> {
      executedSql.push(queryText);

      if (queryText.includes('FROM pg_indexes')) {
        return {
          rows: [{
            indexdef: 'CREATE UNIQUE INDEX idx_tasks_external_identity ON public.tasks USING btree (external_source, external_key) WHERE ((external_source IS NOT NULL) AND (external_key IS NOT NULL))',
          }],
        };
      }

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
    executedSql.some((sql) => sql.includes('DROP INDEX IF EXISTS idx_tasks_external_identity')),
    'expected postgres migration to drop legacy global external identity index',
  );
  assert.ok(
    executedSql.some((sql) => sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_identity ON tasks(project_id, external_source, external_key)')),
    'expected postgres migration to create project-scoped external identity index',
  );
});
