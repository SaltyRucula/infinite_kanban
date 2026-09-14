import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { Pool } from 'pg';
import { initPostgresDatabase } from '../src/db.js';
import { PostgresTaskRepository } from '../src/repositories/postgres.js';
import { PostgresTemplateRepository } from '../src/repositories/postgres-templates.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteTemplateRepository } from '../src/repositories/sqlite-templates.js';
import { isValidAgentType } from '../src/types.js';

function withDbPath<T>(dbPath: string, run: () => Promise<T>): Promise<T> {
  const priorDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  return run().finally(() => {
    if (priorDbPath === undefined) {
      delete process.env.DB_PATH;
      return;
    }
    process.env.DB_PATH = priorDbPath;
  });
}

async function initFreshSqliteDb(dbPath: string): Promise<void> {
  await withDbPath(dbPath, async () => {
    const { initDatabase } = await import(`../src/db.js?agent-type-init=${Date.now()}-${Math.random()}`);
    const db = initDatabase();
    db.close();
  });
}

test('shared AgentType validation is opencode-only', () => {
  assert.equal(isValidAgentType('opencode'), true);
  for (const legacyAgent of ['copilot', 'claude', 'codex', 'hermes', 'openclaw', 'grok']) {
    assert.equal(isValidAgentType(legacyAgent), false);
  }
});

test('sqlite migration rewrites legacy persisted agent types to opencode', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'agent-type-sqlite-migration-'));
  const dbPath = path.join(tempDir, 'legacy.db');

  await initFreshSqliteDb(dbPath);

  const legacyDb = new Database(dbPath);
  legacyDb.prepare('UPDATE projects SET default_agent_type = ? WHERE id = ?').run('claude', 'default');
  legacyDb.prepare(`
    INSERT INTO tasks (id, title, description, priority, column_id, agent_status, created_at, agent_type, archived, project_id, labels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('task-1', 'Legacy Task', '', 'medium', 'backlog', 'idle', 1, 'codex', 0, 'default', '[]');
  legacyDb.prepare(`
    INSERT INTO templates (id, name, title, description, priority, agent_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('tpl-1', 'Legacy Template', 'Template', '', 'medium', 'hermes', 1);
  legacyDb.prepare(`
    INSERT INTO workers (id, name, token_hash, status, hostname, version, agent_types_json, max_concurrent_tasks, registered_at, last_heartbeat_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('worker-1', 'Legacy Worker', 'hash-1', 'online', null, null, '["claude","codex"]', 1, 1, 1, 1);
  legacyDb.close();

  await initFreshSqliteDb(dbPath);

  const migratedDb = new Database(dbPath);
  try {
    const taskAgentType = migratedDb.prepare('SELECT agent_type FROM tasks WHERE id = ?').get('task-1') as { agent_type: string };
    const templateAgentType = migratedDb.prepare('SELECT agent_type FROM templates WHERE id = ?').get('tpl-1') as { agent_type: string };
    const projectAgentType = migratedDb.prepare('SELECT default_agent_type FROM projects WHERE id = ?').get('default') as { default_agent_type: string | null };
    const workerAgentTypes = migratedDb.prepare('SELECT agent_types_json FROM workers WHERE id = ?').get('worker-1') as { agent_types_json: string };

    assert.equal(taskAgentType.agent_type, 'opencode');
    assert.equal(templateAgentType.agent_type, 'opencode');
    assert.equal(projectAgentType.default_agent_type, 'opencode');
    assert.equal(workerAgentTypes.agent_types_json, '["opencode"]');
  } finally {
    migratedDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('sqlite repositories normalize invalid persisted agent types to opencode', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'agent-type-sqlite-repo-'));
  const dbPath = path.join(tempDir, 'repo.db');

  await initFreshSqliteDb(dbPath);
  const db = new Database(dbPath);

  try {
    db.prepare(`
      INSERT INTO tasks (id, title, description, priority, column_id, agent_status, created_at, project_id, agent_type, labels)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('task-invalid', 'Task', '', 'medium', 'backlog', 'idle', 1, 'default', 'legacy-agent', '[]');

    db.prepare(`
      INSERT INTO templates (id, name, title, description, priority, agent_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('tpl-invalid', 'Template', 'Template', '', 'medium', 'legacy-agent', 1);

    const taskRepo = new SqliteTaskRepository(db);
    const templateRepo = new SqliteTemplateRepository(db);

    assert.equal((await taskRepo.getById('task-invalid'))?.agentType, 'opencode');
    assert.equal((await templateRepo.getById('tpl-invalid'))?.agentType, 'opencode');
  } finally {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('postgres migration includes opencode normalization for persisted agent-type columns', async () => {
  const executedSql: string[] = [];
  const pool = {
    async query(queryText: string): Promise<{ rows: Array<{ column_name: string } | { delete_rule: string } | { constraint_name: string } | { indexdef: string }> }> {
      executedSql.push(queryText);
      if (queryText.includes('FROM pg_indexes')) {
        return {
          rows: [{
            indexdef: 'CREATE UNIQUE INDEX idx_tasks_external_identity ON public.tasks USING btree (project_id, external_source, external_key) WHERE ((external_source IS NOT NULL) AND (external_key IS NOT NULL))',
          }],
        };
      }
      return { rows: [] };
    },
  } as Pick<Pool, 'query'>;

  await initPostgresDatabase(pool as Pool);

  assert.ok(executedSql.some((sql) => /UPDATE\s+tasks\s+SET\s+agent_type\s*=\s*'opencode'/i.test(sql)), 'expected tasks migration normalization query');
  assert.ok(executedSql.some((sql) => /UPDATE\s+templates\s+SET\s+agent_type\s*=\s*'opencode'/i.test(sql)), 'expected templates migration normalization query');
  assert.ok(executedSql.some((sql) => /UPDATE\s+projects\s+SET\s+default_agent_type\s*=\s*'opencode'/i.test(sql)), 'expected project migration normalization query');
  assert.ok(executedSql.some((sql) => /UPDATE\s+workers\s+SET\s+agent_types_json\s*=\s*'\["opencode"\]'/i.test(sql)), 'expected worker migration normalization query');
});

test('postgres repositories normalize invalid persisted agent types to opencode', async () => {
  const taskPool = {
    async query(queryText: string): Promise<{ rows: Array<Record<string, unknown>> }> {
      if (queryText.includes('SELECT * FROM tasks WHERE id = $1')) {
        return {
          rows: [{
            id: 'task-invalid',
            title: 'Task',
            description: '',
            priority: 'medium',
            column_id: 'backlog',
            agent_status: 'idle',
            created_at: '1',
            started_at: null,
            completed_at: null,
            repo_path: null,
            branch_name: null,
            base_branch: null,
            use_worktree: null,
            worktree_path: null,
            agent_type: 'legacy-agent',
            archived: false,
            project_id: 'default',
            group_id: null,
            group_order: null,
            summary: null,
            external_source: null,
            external_key: null,
            provenance: null,
            run_requested_at: null,
            run_claimed_at: null,
            timeout_minutes: null,
            clarification_request: null,
            clarification_answer: null,
            assigned_worker_id: null,
            worker_claim_token_hash: null,
            worker_claimed_at: null,
            worker_lease_expires_at: null,
            worker_attempt: 0,
            labels: '[]',
            agent_preference: null,
          }],
        };
      }
      return { rows: [] };
    },
  } as Pick<Pool, 'query'>;

  const templatePool = {
    async query(queryText: string): Promise<{ rows: Array<Record<string, unknown>> }> {
      if (queryText.includes('SELECT * FROM templates WHERE id = $1')) {
        return {
          rows: [{
            id: 'tpl-invalid',
            name: 'Template',
            title: 'Template',
            description: '',
            priority: 'medium',
            agent_type: 'legacy-agent',
            repo_path: null,
            base_branch: null,
            use_worktree: null,
            created_at: '1',
          }],
        };
      }
      return { rows: [] };
    },
  } as Pick<Pool, 'query'>;

  const taskRepo = new PostgresTaskRepository(taskPool as Pool);
  const templateRepo = new PostgresTemplateRepository(templatePool as Pool);

  assert.equal((await taskRepo.getById('task-invalid'))?.agentType, 'opencode');
  assert.equal((await templateRepo.getById('tpl-invalid'))?.agentType, 'opencode');
});
