import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import type { Pool } from 'pg';
import { authMiddleware } from '../src/middleware/auth.js';
import { PostgresEnrollmentCodeRepository } from '../src/repositories/postgres-enrollment-codes.js';
import { SqliteEnrollmentCodeRepository } from '../src/repositories/sqlite-enrollment-codes.js';
import { SqliteWorkerRepository } from '../src/repositories/sqlite-workers.js';
import type { TaskRepository } from '../src/repositories/types.js';
import { createWorkersRouter } from '../src/routes/workers.js';

const serviceToken = 'worker-manager';
const serviceOwnerId = `service:${crypto.createHash('sha256').update(serviceToken).digest('hex')}`;

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
      owner_id TEXT
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

const emptyTasks = {
  async revokeWorkerAssignments() { return []; },
} as unknown as TaskRepository;

async function withServer(
  db: Database.Database,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
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
  }
}

function registrationBody(enrollmentCode: string): Record<string, unknown> {
  return { name: 'fresh-worker', agentTypes: ['opencode'], enrollmentCode };
}

async function createEnrollmentCode(baseUrl: string, projectId = 'project-1'): Promise<{ code: string; expiresAt: number }> {
  const response = await fetch(`${baseUrl}/api/workers/enrollment-codes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  assert.equal(response.status, 201);
  return await response.json() as { code: string; expiresAt: number };
}

test('a scoped enrollment code registers one worker, persists only its hash, and derives the owner identity', async () => {
  const originalServiceTokens = process.env.SERVICE_TOKENS;
  delete process.env.API_KEY;
  process.env.SERVICE_TOKENS = JSON.stringify([{ token: serviceToken, scopes: ['workers:manage'] }]);
  const db = createDatabase();
  try {
    await withServer(db, async (baseUrl) => {
      const enrollment = await createEnrollmentCode(baseUrl);
      assert.ok(enrollment.expiresAt > Date.now());
      assert.ok(enrollment.expiresAt <= Date.now() + 15 * 60 * 1000 + 1_000);

      const stored = db.prepare('SELECT code_hash, owner_id, project_id FROM enrollment_codes').get() as { code_hash: string; owner_id: string; project_id: string };
      assert.notEqual(stored.code_hash, enrollment.code);
      assert.equal(stored.owner_id, serviceOwnerId);
      assert.equal(stored.project_id, 'project-1');

      const registered = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registrationBody(enrollment.code)),
      });
      assert.equal(registered.status, 200);
      const worker = await registered.json() as { worker: { ownerId?: string }; token: string };
      assert.equal(worker.worker.ownerId, serviceOwnerId);
      assert.equal(typeof worker.token, 'string');
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM enrollment_codes').get() as { count: number }).count, 0);

      const replay = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registrationBody(enrollment.code)),
      });
      assert.equal(replay.status, 401);
    });
  } finally {
    db.close();
    if (originalServiceTokens === undefined) delete process.env.SERVICE_TOKENS;
    else process.env.SERVICE_TOKENS = originalServiceTokens;
  }
});

test('enrollment registration rejects expired codes and registration without either credential', async () => {
  const originalServiceTokens = process.env.SERVICE_TOKENS;
  delete process.env.API_KEY;
  process.env.SERVICE_TOKENS = JSON.stringify([{ token: serviceToken, scopes: ['workers:manage'] }]);
  const db = createDatabase();
  try {
    const expired = 'expired-code';
    db.prepare('INSERT INTO enrollment_codes (code_hash, owner_id, project_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
      crypto.createHash('sha256').update(expired).digest('hex'), serviceOwnerId, null, Date.now() - 1, Date.now() - 60_000,
    );
    await withServer(db, async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registrationBody('')),
      });
      assert.equal(missing.status, 401);
      const response = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registrationBody(expired)),
      });
      assert.equal(response.status, 401);
    });
  } finally {
    db.close();
    if (originalServiceTokens === undefined) delete process.env.SERVICE_TOKENS;
    else process.env.SERVICE_TOKENS = originalServiceTokens;
  }
});

test('existing bearer-scoped worker registration remains available without an enrollment code', async () => {
  const originalServiceTokens = process.env.SERVICE_TOKENS;
  delete process.env.API_KEY;
  process.env.SERVICE_TOKENS = JSON.stringify([{ token: 'worker-registrar', scopes: ['workers:register'] }]);
  const db = createDatabase();
  try {
    await withServer(db, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST',
        headers: { authorization: 'Bearer worker-registrar', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'bearer-worker', agentTypes: ['opencode'] }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { worker: { ownerId?: string }; token: string };
      assert.equal(body.worker.ownerId, undefined);
      assert.equal(typeof body.token, 'string');
    });
  } finally {
    db.close();
    if (originalServiceTokens === undefined) delete process.env.SERVICE_TOKENS;
    else process.env.SERVICE_TOKENS = originalServiceTokens;
  }
});

test('enrollment creation requires workers:manage and concurrent registration consumes a code once', async () => {
  const originalServiceTokens = process.env.SERVICE_TOKENS;
  delete process.env.API_KEY;
  process.env.SERVICE_TOKENS = JSON.stringify([
    { token: serviceToken, scopes: ['workers:manage'] },
    { token: 'read-only', scopes: ['projects:read'] },
  ]);
  const db = createDatabase();
  try {
    await withServer(db, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/api/workers/enrollment-codes`, { method: 'POST' })).status, 401);
      assert.equal((await fetch(`${baseUrl}/api/workers/enrollment-codes`, {
        method: 'POST', headers: { authorization: 'Bearer read-only', 'content-type': 'application/json' }, body: '{}',
      })).status, 403);

      const enrollment = await createEnrollmentCode(baseUrl);
      const responses = await Promise.all(Array.from({ length: 2 }, () => fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registrationBody(enrollment.code)),
      })));
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
    });
  } finally {
    db.close();
    if (originalServiceTokens === undefined) delete process.env.SERVICE_TOKENS;
    else process.env.SERVICE_TOKENS = originalServiceTokens;
  }
});

test('Postgres enrollment repository uses hash creation and atomic expiry-aware consumption SQL', async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const pool = {
    async query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
      queries.push({ text, params: params ?? [] });
      return { rows: text.includes('DELETE') ? [{ owner_id: serviceOwnerId, project_id: 'project-1' }] : [] };
    },
  } as Pick<Pool, 'query'>;
  const repo = new PostgresEnrollmentCodeRepository(pool as Pool);
  await repo.create({ codeHash: 'hash', ownerId: serviceOwnerId, projectId: 'project-1', expiresAt: 2, createdAt: 1 });
  const consumed = await repo.consume('hash', 1);
  assert.deepEqual(consumed, { ownerId: serviceOwnerId, projectId: 'project-1' });
  assert.match(queries[0]?.text ?? '', /INSERT INTO enrollment_codes/);
  assert.match(queries[1]?.text ?? '', /DELETE FROM enrollment_codes/);
  assert.match(queries[1]?.text ?? '', /expires_at > \$2/);
  assert.match(queries[1]?.text ?? '', /RETURNING owner_id, project_id/);
});
