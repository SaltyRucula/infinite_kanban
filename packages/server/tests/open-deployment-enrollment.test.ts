import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { authMiddleware } from '../src/middleware/auth.js';
import { SqliteEnrollmentCodeRepository } from '../src/repositories/sqlite-enrollment-codes.js';
import { SqliteWorkerRepository } from '../src/repositories/sqlite-workers.js';
import type { TaskRepository } from '../src/repositories/types.js';
import { createWorkersRouter } from '../src/routes/workers.js';

/**
 * A deployment with no API_KEY and no SERVICE_TOKENS is open on purpose — its
 * boundary is the network. Worker enrollment still has to work there: the
 * route needs an owner id, and without a principal it answered 401 while
 * every other endpoint on the same deployment was open, leaving no way to
 * enrol a worker at all.
 */

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
    CREATE TABLE enrollment_codes (
      code_hash TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      project_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

const emptyTasks = { async revokeWorkerAssignments() { return []; } } as unknown as TaskRepository;

async function withOpenDeployment(
  db: Database.Database,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const originalApiKey = process.env.API_KEY;
  const originalServiceTokens = process.env.SERVICE_TOKENS;
  delete process.env.API_KEY;
  delete process.env.SERVICE_TOKENS;

  const app = express();
  app.use(express.json());
  app.use('/api', authMiddleware);
  app.use('/api/workers', createWorkersRouter(
    emptyTasks,
    new SqliteWorkerRepository(db),
    new SqliteEnrollmentCodeRepository(db),
  ));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (originalApiKey === undefined) delete process.env.API_KEY; else process.env.API_KEY = originalApiKey;
    if (originalServiceTokens === undefined) delete process.env.SERVICE_TOKENS; else process.env.SERVICE_TOKENS = originalServiceTokens;
  }
}

test('an open deployment can mint an enrollment code without a credential', async () => {
  const db = createDatabase();
  try {
    await withOpenDeployment(db, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/workers/enrollment-codes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'project-1' }),
      });
      assert.equal(response.status, 201);
      const body = await response.json() as { code: string; expiresAt: number };
      assert.ok(body.code.length > 0);
      assert.ok(body.expiresAt > Date.now());

      // Only the hash is persisted, and it is owned by the open-deployment
      // operator rather than a per-token service identity.
      const stored = db.prepare('SELECT code_hash, owner_id, project_id FROM enrollment_codes').get() as {
        code_hash: string; owner_id: string; project_id: string;
      };
      assert.notEqual(stored.code_hash, body.code);
      assert.equal(stored.owner_id, 'open-deployment');
      assert.equal(stored.project_id, 'project-1');
    });
  } finally {
    db.close();
  }
});

test('the code an open deployment mints registers exactly one worker', async () => {
  const db = createDatabase();
  try {
    await withOpenDeployment(db, async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/workers/enrollment-codes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(created.status, 201);
      const { code } = await created.json() as { code: string };

      const body = {
        name: 'fresh-worker',
        agentTypes: ['opencode'],
        maxConcurrentTasks: 1,
        // Registration requires explicit consent arrays; empty means "no
        // project or label opt-in yet", which is still a valid registration.
        acceptedProjectIds: [],
        acceptedLabels: [],
        enrollmentCode: code,
      };
      const first = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(first.status, 200);
      const registered = await first.json() as { worker: { ownerId?: string }; token: string };
      assert.ok(registered.token.length > 0);

      // Codes are single-use: replaying one must not enrol a second worker.
      const replay = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(replay.status, 401);
      const workerCount = db.prepare('SELECT COUNT(*) AS count FROM workers').get() as { count: number };
      assert.equal(workerCount.count, 1);
    });
  } finally {
    db.close();
  }
});

test('configuring any credential restores scoped enforcement', async () => {
  // The open-deployment principal must not leak into a deployment that has
  // declared credentials: there, an unauthenticated caller stays unauthorized.
  const originalApiKey = process.env.API_KEY;
  const originalServiceTokens = process.env.SERVICE_TOKENS;
  delete process.env.API_KEY;
  process.env.SERVICE_TOKENS = JSON.stringify([{ token: 'worker-manager', scopes: ['workers:manage'] }]);
  const db = createDatabase();

  const app = express();
  app.use(express.json());
  app.use('/api', authMiddleware);
  app.use('/api/workers', createWorkersRouter(
    emptyTasks,
    new SqliteWorkerRepository(db),
    new SqliteEnrollmentCodeRepository(db),
  ));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const anonymous = await fetch(`${baseUrl}/api/workers/enrollment-codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(anonymous.status, 401);

    const scoped = await fetch(`${baseUrl}/api/workers/enrollment-codes`, {
      method: 'POST',
      headers: { authorization: 'Bearer worker-manager', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(scoped.status, 201);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    if (originalApiKey === undefined) delete process.env.API_KEY; else process.env.API_KEY = originalApiKey;
    if (originalServiceTokens === undefined) delete process.env.SERVICE_TOKENS; else process.env.SERVICE_TOKENS = originalServiceTokens;
  }
});
