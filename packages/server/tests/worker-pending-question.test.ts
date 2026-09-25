import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type Database from 'better-sqlite3';
import { createAgentRouter } from '../src/routes/agent.js';
import { createWorkersRouter } from '../src/routes/workers.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteWorkerRepository } from '../src/repositories/sqlite-workers.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import type { Task, WorkerTaskAssignment } from '../src/types.js';

const QUESTION = 'Which API version should the client target?';

async function openDatabase(): Promise<{ db: Database.Database; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-pending-'));
  const originalDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(dir, 'board.db');
  try {
    const { initDatabase } = await import(`../src/db.js?worker-pending=${Date.now()}-${Math.random()}`);
    const db = initDatabase() as Database.Database;
    return {
      db,
      cleanup: () => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  } finally {
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
  }
}

const agentManager = {
  isRunning: () => false,
  resetEvents: () => {},
  getSessionIdentity: () => undefined,
  stopAgent: async () => false,
} as unknown as AgentManager;

type Harness = {
  readonly baseUrl: string;
  readonly tasks: SqliteTaskRepository;
  claim(): Promise<string>;
  complete(claimToken: string, body: Record<string, unknown>): Promise<Response>;
  assignments(): Promise<readonly WorkerTaskAssignment[]>;
  task(): Promise<Task>;
};

async function withHarness(callback: (harness: Harness) => Promise<void>): Promise<void> {
  const { db, cleanup } = await openDatabase();
  const tasks = new SqliteTaskRepository(db);
  const workers = new SqliteWorkerRepository(db);
  await workers.register({
    id: 'worker-1',
    name: 'worker',
    tokenHash: crypto.createHash('sha256').update('worker-token').digest('hex'),
    agentTypes: ['opencode'],
    maxConcurrentTasks: 1,
    registeredAt: Date.now(),
  });
  await tasks.create({
    id: 'task-1',
    projectId: 'default',
    title: 'Build client',
    description: 'Build the API client',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'planning',
    agentType: 'opencode',
    createdAt: Date.now(),
    labels: [],
  });
  await tasks.assignToWorker('task-1', 'worker-1');
  await tasks.requestRun('task-1', Date.now());

  const app = express();
  app.use(express.json());
  app.use('/api/workers', createWorkersRouter(tasks, workers));
  app.use('/api/tasks', createAgentRouter(tasks, agentManager, undefined, undefined, workers));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: 'Bearer worker-token', 'content-type': 'application/json' };

  const harness: Harness = {
    baseUrl,
    tasks,
    async claim() {
      const response = await fetch(`${baseUrl}/api/workers/me/tasks/task-1/claim`, { method: 'POST', headers });
      assert.equal(response.status, 200);
      return (await response.json() as { claimToken: string }).claimToken;
    },
    complete(claimToken, body) {
      return fetch(`${baseUrl}/api/workers/me/tasks/task-1/complete`, {
        method: 'POST',
        headers: { ...headers, 'x-worker-claim': claimToken },
        body: JSON.stringify(body),
      });
    },
    async assignments() {
      const response = await fetch(`${baseUrl}/api/workers/me/assignments`, { headers });
      return (await response.json() as { tasks: WorkerTaskAssignment[] }).tasks;
    },
    async task() {
      const value = await tasks.getById('task-1');
      assert.ok(value);
      return value;
    },
  };

  try {
    await callback(harness);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    cleanup();
  }
}

async function answer(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/tasks/task-1/clarification/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('a worker question moves the task to pending and the answer resumes the same task and session', async () => {
  await withHarness(async (h) => {
    const firstClaim = await h.claim();
    const paused = await h.complete(firstClaim, { status: 'awaiting_input', question: QUESTION, sessionId: 'ses_1' });
    assert.equal(paused.status, 200);

    const pending = await h.task();
    assert.equal(pending.columnId, 'pending');
    assert.equal(pending.agentStatus, 'awaiting_clarification');
    assert.equal(pending.clarificationRequest?.prompt, QUESTION);
    assert.equal(pending.clarificationRequest?.sessionId, 'ses_1');
    assert.deepEqual(await h.assignments(), [], 'a pending task is not handed out until answered');
    const events = await h.tasks.getEventsByTaskId('task-1');
    assert.equal(events.some((event) => event.metadata?.clarification_request?.prompt === QUESTION), true);

    const requestId = pending.clarificationRequest?.requestId;
    assert.ok(requestId);
    const stale = await answer(h.baseUrl, { requestId: 'other', sessionId: 'ses_1', answer: 'v2' });
    assert.equal(stale.status, 409);

    const resumed = await answer(h.baseUrl, { requestId, sessionId: 'ses_1', answer: 'Use v2' });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json() as { code: string }).code, 'requeued_for_worker');

    const requeued = await h.task();
    assert.equal(requeued.id, 'task-1');
    assert.equal(requeued.columnId, 'in-progress');
    assert.equal(requeued.agentStatus, 'planning');

    const [assignment] = await h.assignments();
    assert.deepEqual(assignment?.resume, { sessionId: 'ses_1', question: QUESTION, answer: 'Use v2' });

    // The first completion released the claim, so the same task is claimable again.
    const secondClaim = await h.claim();
    const done = await h.complete(secondClaim, { status: 'complete', summary: 'done' });
    assert.equal(done.status, 200);

    const reviewed = await h.task();
    assert.equal(reviewed.columnId, 'review');
    assert.equal(reviewed.agentStatus, 'complete');
    assert.equal(reviewed.clarificationRequest ?? null, null);
    assert.equal(reviewed.clarificationAnswer ?? null, null);
  });
});

test('a worker that completes without a question moves the task to review', async () => {
  await withHarness(async (h) => {
    const claim = await h.claim();
    assert.equal((await h.complete(claim, { status: 'complete' })).status, 200);
    assert.equal((await h.task()).columnId, 'review');
  });
});

test('awaiting_input without a question is rejected', async () => {
  await withHarness(async (h) => {
    const claim = await h.claim();
    assert.equal((await h.complete(claim, { status: 'awaiting_input', question: '  ' })).status, 400);
    assert.equal((await h.task()).columnId, 'in-progress');
  });
});

test('stopping a pending worker task fails it back to in-progress', async () => {
  await withHarness(async (h) => {
    const claim = await h.claim();
    await h.complete(claim, { status: 'awaiting_input', question: QUESTION, sessionId: 'ses_1' });

    const stopped = await fetch(`${h.baseUrl}/api/tasks/task-1/stop`, { method: 'POST' });
    assert.equal(stopped.status, 200);
    const task = await h.task();
    assert.equal(task.agentStatus, 'failed');
    assert.equal(task.columnId, 'in-progress');
    assert.equal(task.clarificationRequest ?? null, null);
  });
});
