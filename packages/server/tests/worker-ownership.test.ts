import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { authMiddleware } from '../src/middleware/auth.js';
import { SqliteWorkerRepository } from '../src/repositories/sqlite-workers.js';
import type { TaskRepository } from '../src/repositories/types.js';
import { createWorkersRouter } from '../src/routes/workers.js';

const emptyTasks = { async revokeWorkerAssignments() { return []; } } as unknown as TaskRepository;

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, hostname TEXT, version TEXT, agent_types_json TEXT NOT NULL,
      max_concurrent_tasks INTEGER NOT NULL, registered_at INTEGER NOT NULL,
      last_heartbeat_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      disabled_at INTEGER, token_issued_at INTEGER NOT NULL, owner_id TEXT,
      accepted_project_ids_json TEXT NOT NULL DEFAULT '[]',
      accepted_labels_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      assigned_worker_id TEXT,
      agent_status TEXT,
      run_requested_at INTEGER
    );
  `);
  return db;
}

async function withServer(db: Database.Database, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', authMiddleware);
  app.use('/api/workers', createWorkersRouter(emptyTasks, new SqliteWorkerRepository(db)));
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

test('workers are owned by configured principals and listings hide hostnames', async () => {
  const originalApiKey = process.env.API_KEY;
  const originalServiceTokens = process.env.SERVICE_TOKENS;
  delete process.env.API_KEY;
  process.env.SERVICE_TOKENS = JSON.stringify([
    { token: 'owner-a-token', id: 'owner-a', scopes: ['workers:manage'] },
    { token: 'owner-b-token', id: 'owner-b', scopes: ['workers:manage', 'workers:register'] },
  ]);
  const db = createDatabase();
  try {
    const insertWorker = db.prepare(`
      INSERT INTO workers (
        id, name, token_hash, status, hostname, version, agent_types_json,
        max_concurrent_tasks, registered_at, last_heartbeat_at, updated_at,
        disabled_at, token_issued_at, owner_id
      ) VALUES (?, ?, ?, 'online', ?, NULL, '["opencode"]', 1, 1, 1, 1, NULL, 1, ?)
    `);
    insertWorker.run('worker-a', 'worker a', 'hash-a', 'owner-a-host', 'owner-a');
    insertWorker.run('worker-b', 'worker b', 'hash-b', 'owner-b-host', 'owner-b');

    await withServer(db, async (baseUrl) => {
      const ownerA = await fetch(`${baseUrl}/api/workers`, { headers: { authorization: 'Bearer owner-a-token' } });
      assert.equal(ownerA.status, 200);
      assert.deepEqual(await ownerA.json(), [{
        id: 'worker-a', name: 'worker a', status: 'online', agentTypes: ['opencode'],
        maxConcurrentTasks: 1, registeredAt: 1, lastHeartbeatAt: 1, updatedAt: 1, ownerId: 'owner-a',
      }]);

      const registered = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST',
        headers: { authorization: 'Bearer owner-b-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'registered by owner b',
          agentTypes: ['opencode'],
          acceptedProjectIds: ['default'],
          acceptedLabels: [],
        }),
      });
      assert.equal(registered.status, 200);
      const body = await registered.json() as { worker: { ownerId?: string; hostname?: string } };
      assert.equal(body.worker.ownerId, 'owner-b');
      assert.equal(body.worker.hostname, undefined);
    });
  } finally {
    db.close();
    if (originalApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = originalApiKey;
    if (originalServiceTokens === undefined) delete process.env.SERVICE_TOKENS;
    else process.env.SERVICE_TOKENS = originalServiceTokens;
  }
});
