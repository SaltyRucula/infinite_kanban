import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';
import { coerceAgentType, coerceOptionalAgentType } from '../../../shared/constants.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteTemplateRepository } from '../src/repositories/sqlite-templates.js';
import { SqliteProjectRepository } from '../src/repositories/sqlite-projects.js';
import { SqliteWorkerRepository } from '../src/repositories/sqlite-workers.js';

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT, repo_url TEXT,
      is_default INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      default_agent_type TEXT, default_priority TEXT, default_base_branch TEXT,
      default_use_worktree INTEGER, aliases TEXT NOT NULL DEFAULT '[]',
      jira_import_enabled INTEGER NOT NULL DEFAULT 0, jira_import_interval_minutes INTEGER NOT NULL DEFAULT 15,
      jira_import_auto_start INTEGER NOT NULL DEFAULT 0, jira_import_last_run_at INTEGER,
      jira_import_last_completed_at INTEGER, jira_import_last_success_at INTEGER,
      jira_import_last_error TEXT, jira_import_last_total INTEGER, jira_import_last_created INTEGER,
      jira_import_last_skipped INTEGER
    );
    INSERT INTO projects VALUES ('default', 'Default', NULL, NULL, 1, 1, 1, NULL, NULL, NULL, NULL, '[]', 0, 15, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    CREATE TABLE task_groups (id TEXT PRIMARY KEY, project_id TEXT, column_id TEXT, archived INTEGER);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, priority TEXT, column_id TEXT,
      agent_status TEXT, agent_type TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER,
      repo_path TEXT, branch_name TEXT, base_branch TEXT, use_worktree INTEGER, worktree_path TEXT,
      archived INTEGER, group_id TEXT, group_order INTEGER, summary TEXT, external_source TEXT,
      external_key TEXT, provenance TEXT, run_requested_at INTEGER, run_claimed_at INTEGER,
      timeout_minutes INTEGER, clarification_request TEXT, clarification_answer TEXT, assigned_worker_id TEXT,
      worker_claim_token_hash TEXT, worker_claimed_at INTEGER, worker_lease_expires_at INTEGER,
      worker_attempt INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]', agent_preference TEXT
    );
    CREATE TABLE events (id TEXT, task_id TEXT, type TEXT, content TEXT, timestamp INTEGER, metadata TEXT);
    CREATE TABLE templates (id TEXT PRIMARY KEY, name TEXT, title TEXT, description TEXT, priority TEXT, agent_type TEXT, repo_path TEXT, base_branch TEXT, use_worktree INTEGER, created_at INTEGER);
    CREATE TABLE workers (id TEXT PRIMARY KEY, name TEXT, token_hash TEXT, status TEXT, hostname TEXT, version TEXT, agent_types_json TEXT, max_concurrent_tasks INTEGER, registered_at INTEGER, last_heartbeat_at INTEGER, updated_at INTEGER, disabled_at INTEGER);
  `);
  return db;
}

test('legacy agent values coerce consistently to OpenCode', () => {
  assert.equal(coerceAgentType('claude'), 'opencode');
  assert.equal(coerceAgentType('unknown-provider'), 'opencode');
  assert.equal(coerceOptionalAgentType(null), undefined);
  assert.equal(coerceOptionalAgentType('codex'), 'opencode');
});

test('SQLite repositories expose legacy task/template/project/worker values as OpenCode', async () => {
  const db = createDatabase();
  try {
    db.prepare('INSERT INTO tasks (id, project_id, title, description, priority, column_id, agent_status, agent_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('task-1', 'default', 'Task', '', 'medium', 'backlog', 'idle', 'claude', 1);
    db.prepare('INSERT INTO templates (id, name, title, description, priority, agent_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('template-1', 'Template', 'Task', '', 'medium', 'codex', 1);
    db.prepare('UPDATE projects SET default_agent_type = ? WHERE id = ?').run('hermes', 'default');
    db.prepare('INSERT INTO workers (id, name, token_hash, status, agent_types_json, max_concurrent_tasks, registered_at, last_heartbeat_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('worker-1', 'Worker', 'hash', 'online', '["openclaw","grok"]', 1, 1, 1, 1);

    assert.equal((await new SqliteTaskRepository(db).getById('task-1'))?.agentType, 'opencode');
    assert.equal((await new SqliteTemplateRepository(db).getById('template-1'))?.agentType, 'opencode');
    assert.equal((await new SqliteProjectRepository(db).getById('default'))?.defaultAgentType, 'opencode');
    assert.deepEqual((await new SqliteWorkerRepository(db).getById('worker-1'))?.agentTypes, ['opencode', 'opencode']);
  } finally {
    db.close();
  }
});
