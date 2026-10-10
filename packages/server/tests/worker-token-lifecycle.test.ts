import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteWorkerRepository } from '../src/repositories/sqlite-workers.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { Task } from '../src/types.js';
import { createWorkersRouter } from '../src/routes/workers.js';

const workerToken = 'worker-token';
const workerTokenHash = crypto.createHash('sha256').update(workerToken).digest('hex');

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      hostname TEXT,
      version TEXT,
      agent_types_json TEXT NOT NULL,
      max_concurrent_tasks INTEGER NOT NULL,
      registered_at INTEGER NOT NULL,
      last_heartbeat_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      disabled_at INTEGER,
      token_issued_at INTEGER NOT NULL,
      owner_id TEXT,
      accepted_project_ids_json TEXT NOT NULL DEFAULT '[]',
      accepted_labels_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE worker_task_sessions (
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      base_url TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, session_id)
    );
    CREATE TABLE worker_task_commands (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      message TEXT,
      attachment_ids_json TEXT,
      request_id TEXT,
      session_id TEXT,
      answer TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
      priority TEXT NOT NULL, column_id TEXT NOT NULL, agent_status TEXT NOT NULL,
      created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
      repo_path TEXT, branch_name TEXT, base_branch TEXT, use_worktree INTEGER,
      worktree_path TEXT, agent_type TEXT NOT NULL, archived INTEGER NOT NULL,
      project_id TEXT NOT NULL, group_id TEXT, group_order INTEGER, summary TEXT,
      external_source TEXT, external_key TEXT, provenance TEXT,
      run_requested_at INTEGER, run_claimed_at INTEGER, timeout_minutes INTEGER,
      clarification_request TEXT, clarification_answer TEXT, assigned_worker_id TEXT,
      worker_claim_token_hash TEXT, worker_claimed_at INTEGER, worker_lease_expires_at INTEGER,
      worker_attempt INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]', agent_preference TEXT
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL,
      timestamp INTEGER NOT NULL, metadata TEXT, importance TEXT
    );
  `);
  return db;
}

async function createWorker(db: Database.Database, registeredAt = Date.now()): Promise<SqliteWorkerRepository> {
  const workers = new SqliteWorkerRepository(db);
  await workers.register({
    id: 'worker-1',
    name: 'worker',
    tokenHash: workerTokenHash,
    agentTypes: ['opencode'],
    maxConcurrentTasks: 1,
    registeredAt,
  });
  return workers;
}

async function withServer(
  workers: SqliteWorkerRepository,
  tasks: TaskRepository,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/workers', createWorkersRouter(tasks, workers));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function workerHeaders(token = workerToken): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

test('worker lifecycle routes disable, rotate, and delete a worker token', async () => {
  const db = createDatabase();
  try {
    const workers = await createWorker(db);
    const releasedTask = { id: 'task-1' } as Task;
    const tasks = new SqliteTaskRepository(db);
    db.prepare(`INSERT INTO tasks (id, title, description, priority, column_id, agent_status, created_at, agent_type, archived, project_id, labels, assigned_worker_id, run_requested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(releasedTask.id, 'Revoked task', '', 'medium', 'in-progress', 'planning', Date.now(), 'opencode', 0, 'default', '[]', 'worker-1', Date.now());
    await workers.registerTaskSession(releasedTask.id, 'session-1', 'http://127.0.0.1:4455/session/task-1', Date.now());
    await workers.enqueueTaskCommand(releasedTask.id, { id: 'command-1', type: 'cancel', createdAt: Date.now() });
    await withServer(workers, tasks, async (baseUrl) => {
      const disabled = await fetch(`${baseUrl}/api/workers/worker-1/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'disabled' }),
      });
      assert.equal(disabled.status, 200);
      assert.equal((await disabled.json() as { status: string }).status, 'disabled');
      assert.deepEqual(await workers.getTaskSessions(releasedTask.id), []);
      assert.deepEqual(await workers.claimTaskCommands(releasedTask.id, 20), []);
      const revokedTask = await tasks.getById(releasedTask.id);
      assert.equal(revokedTask?.assignedWorkerId, null);
      assert.equal(revokedTask?.agentStatus, 'failed');

      const disabledAuth = await fetch(`${baseUrl}/api/workers/me/assignments`, { headers: workerHeaders() });
      assert.equal(disabledAuth.status, 401);

      const enabled = await fetch(`${baseUrl}/api/workers/worker-1/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'online' }),
      });
      assert.equal(enabled.status, 200);

      const rotated = await fetch(`${baseUrl}/api/workers/me/rotate`, { method: 'POST', headers: workerHeaders() });
      assert.equal(rotated.status, 200);
      const rotatedBody = await rotated.json() as { token: string };
      assert.notEqual(rotatedBody.token, workerToken);

      const oldToken = await fetch(`${baseUrl}/api/workers/me/assignments`, { headers: workerHeaders() });
      assert.equal(oldToken.status, 401);

      const newToken = await fetch(`${baseUrl}/api/workers/me/assignments`, { headers: workerHeaders(rotatedBody.token) });
      assert.equal(newToken.status, 200);

      const removed = await fetch(`${baseUrl}/api/workers/worker-1`, { method: 'DELETE' });
      assert.equal(removed.status, 204);

      const deletedToken = await fetch(`${baseUrl}/api/workers/me/assignments`, { headers: workerHeaders(rotatedBody.token) });
      assert.equal(deletedToken.status, 401);
    });
  } finally {
    db.close();
  }
});

test('worker authentication rejects tokens older than the maximum token age', async () => {
  const db = createDatabase();
  try {
    const workers = await createWorker(db, Date.now() - 91 * 24 * 60 * 60 * 1000);
    await withServer(workers, {
      async getWorkerAssignments(): Promise<[]> { return []; },
      async revokeWorkerAssignments(): Promise<Task[]> { return []; },
    } as TaskRepository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/workers/me/assignments`, { headers: workerHeaders() });
      assert.equal(response.status, 401);
    });
  } finally {
    db.close();
  }
});
