import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';
import type { Pool } from 'pg';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { PostgresTaskRepository } from '../src/repositories/postgres.js';
import type { AgentEvent } from '../src/types.js';

function createSqliteDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
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
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      type TEXT,
      content TEXT,
      timestamp INTEGER,
      metadata TEXT,
      importance TEXT
    );
  `);
  return db;
}

test('sqlite: insertEvent + getEventsByTaskId round-trips importance', async () => {
  const db = createSqliteDb();
  try {
    const repo = new SqliteTaskRepository(db);
    const event: AgentEvent = {
      id: 'evt-1',
      taskId: 'task-1',
      type: 'file_write',
      content: 'wrote a file',
      timestamp: 1,
      importance: 'milestone',
    };

    await repo.insertEvent(event);
    const [readBack] = await repo.getEventsByTaskId('task-1');

    assert.ok(readBack, 'expected event to be persisted');
    assert.equal(readBack.importance, 'milestone');
  } finally {
    db.close();
  }
});

test('sqlite: a NULL importance column (pre-migration row) reads back as undefined, not a throw', async () => {
  const db = createSqliteDb();
  try {
    const repo = new SqliteTaskRepository(db);
    // Simulate a row written before the importance column existed / before
    // this lane shipped — insert directly with a NULL importance.
    db.prepare(`
      INSERT INTO events (id, task_id, type, content, timestamp, metadata, importance)
      VALUES ('evt-old', 'task-1', 'thinking', 'legacy content', 1, NULL, NULL)
    `).run();

    const [readBack] = await repo.getEventsByTaskId('task-1');

    assert.ok(readBack);
    assert.equal(readBack.importance, undefined);
    assert.equal(readBack.content, 'legacy content');
  } finally {
    db.close();
  }
});

test('postgres: insertEvent writes importance and getEventsByTaskId round-trips it', async () => {
  const inserted: unknown[] = [];
  const pool = {
    async query(queryText: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      if (queryText.includes('INSERT INTO events')) {
        inserted.push(params);
        return { rows: [] };
      }
      if (queryText.includes('SELECT * FROM events WHERE task_id')) {
        return {
          rows: [{
            id: 'evt-1',
            task_id: 'task-1',
            type: 'file_write',
            content: 'wrote a file',
            timestamp: '1',
            metadata: null,
            importance: 'milestone',
          }],
        };
      }
      return { rows: [] };
    },
  } as Pick<Pool, 'query'>;

  const repo = new PostgresTaskRepository(pool as Pool);
  const event: AgentEvent = {
    id: 'evt-1',
    taskId: 'task-1',
    type: 'file_write',
    content: 'wrote a file',
    timestamp: 1,
    importance: 'milestone',
  };

  await repo.insertEvent(event);
  assert.equal(inserted.length, 1);
  assert.equal((inserted[0] as unknown[])[6], 'milestone');

  const [readBack] = await repo.getEventsByTaskId('task-1');
  assert.equal(readBack.importance, 'milestone');
});

test('postgres: a NULL importance column (pre-migration row) reads back as undefined, not a throw', async () => {
  const pool = {
    async query(queryText: string): Promise<{ rows: unknown[] }> {
      if (queryText.includes('SELECT * FROM events WHERE task_id')) {
        return {
          rows: [{
            id: 'evt-old',
            task_id: 'task-1',
            type: 'thinking',
            content: 'legacy content',
            timestamp: '1',
            metadata: null,
            importance: null,
          }],
        };
      }
      return { rows: [] };
    },
  } as Pick<Pool, 'query'>;

  const repo = new PostgresTaskRepository(pool as Pool);
  const [readBack] = await repo.getEventsByTaskId('task-1');

  assert.ok(readBack);
  assert.equal(readBack.importance, undefined);
  assert.equal(readBack.content, 'legacy content');
});
