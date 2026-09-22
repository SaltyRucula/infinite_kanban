import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';

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
  `);
  return db;
}

// Regression test: a task that already ran and reached a terminal status
// (failed/complete) but still has run_requested_at set and no active claim
// used to be returned forever by getWorkerAssignments. Because the worker
// CLI always claims tasks[0], one such zombie assignment permanently blocked
// that worker from ever picking up new, eligible work.
test('getWorkerAssignments excludes terminal-status tasks even with a stale run_requested_at', async () => {
  const db = createDatabase();
  try {
    const repo = new SqliteTaskRepository(db);
    const insert = db.prepare(`INSERT INTO tasks (id, project_id, title, description, priority, column_id, agent_status, agent_type, created_at, assigned_worker_id, run_requested_at, worker_claim_token_hash) VALUES (@id, 'default', @title, '', 'low', 'in-progress', @agent_status, 'opencode', 1, 'worker-1', @run_requested_at, NULL)`);

    insert.run({ id: 'zombie-failed', title: 'Zombie failed task', agent_status: 'failed', run_requested_at: 100 });
    insert.run({ id: 'zombie-complete', title: 'Zombie complete task', agent_status: 'complete', run_requested_at: 200 });
    insert.run({ id: 'eligible-idle', title: 'Eligible idle task', agent_status: 'idle', run_requested_at: 300 });

    const assignments = await repo.getWorkerAssignments('worker-1', 1_000);

    assert.deepEqual(assignments.map((task) => task.id), ['eligible-idle']);
  } finally {
    db.close();
  }
});
