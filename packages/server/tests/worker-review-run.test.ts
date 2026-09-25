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
import type { ColumnId, Task, WorkerTaskAssignment } from '../src/types.js';

async function openDatabase(): Promise<{ db: Database.Database; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-review-'));
  const originalDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(dir, 'board.db');
  try {
    const { initDatabase } = await import(`../src/db.js?worker-review=${Date.now()}-${Math.random()}`);
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
  startAgent: () => { throw new Error('worker tasks must not start in-process'); },
} as unknown as AgentManager;

// /run is rate limited per task id across the process, so each test uses its own task.
let taskCounter = 0;

type Harness = {
  run(): Promise<Task>;
  requeue(): Promise<void>;
  assignments(): Promise<readonly WorkerTaskAssignment[]>;
  claim(): Promise<{ task: WorkerTaskAssignment; claimToken: string }>;
  complete(claimToken: string, body: Record<string, unknown>): Promise<Response>;
  task(): Promise<Task>;
  events(): Promise<string[]>;
};

async function withHarness(columnId: ColumnId, callback: (harness: Harness) => Promise<void>): Promise<void> {
  const taskId = `task-${++taskCounter}`;
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
    id: taskId,
    projectId: 'default',
    title: 'Add retry to client',
    description: 'Retry failed requests three times',
    priority: 'medium',
    columnId,
    agentStatus: 'idle',
    agentType: 'opencode',
    createdAt: Date.now(),
    branchName: 'feature/retry',
    baseBranch: 'main',
    labels: [],
  });
  await tasks.assignToWorker(taskId, 'worker-1');

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
    async run() {
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/run`, { method: 'POST' });
      assert.equal(response.status, 200);
      return await response.json() as Task;
    },
    async requeue() {
      await tasks.requestRun(taskId, Date.now());
      await tasks.update(taskId, { agentStatus: 'planning' });
    },
    async assignments() {
      const response = await fetch(`${baseUrl}/api/workers/me/assignments`, { headers });
      return (await response.json() as { tasks: WorkerTaskAssignment[] }).tasks;
    },
    async claim() {
      const response = await fetch(`${baseUrl}/api/workers/me/tasks/${taskId}/claim`, { method: 'POST', headers });
      assert.equal(response.status, 200);
      return await response.json() as { task: WorkerTaskAssignment; claimToken: string };
    },
    complete(claimToken, body) {
      return fetch(`${baseUrl}/api/workers/me/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: { ...headers, 'x-worker-claim': claimToken },
        body: JSON.stringify(body),
      });
    },
    async task() {
      const value = await tasks.getById(taskId);
      assert.ok(value);
      return value;
    },
    async events() {
      return (await tasks.getEventsByTaskId(taskId)).map((event) => event.content);
    },
  };

  try {
    await callback(harness);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    cleanup();
  }
}

test('a run started from Review stays in Review and is handed to the worker in review mode', async () => {
  await withHarness('review', async (h) => {
    const started = await h.run();
    assert.equal(started.columnId, 'review');

    const [assignment] = await h.assignments();
    assert.equal(assignment?.mode, 'review');
    const { task, claimToken } = await h.claim();
    assert.equal(task.mode, 'review');

    const done = await h.complete(claimToken, { status: 'complete', reviewVerdict: 'pass', summary: 'All requirements met.' });
    assert.equal(done.status, 200);

    const reviewed = await h.task();
    assert.equal(reviewed.columnId, 'review');
    assert.equal(reviewed.agentStatus, 'complete');
    assert.equal(reviewed.summary, 'All requirements met.');
    assert.equal((await h.events()).some((content) => content.startsWith('Review passed.')), true);
  });
});

test('a review that requests changes moves the task back to In Progress with the findings', async () => {
  await withHarness('review', async (h) => {
    await h.run();
    const { claimToken } = await h.claim();

    const done = await h.complete(claimToken, {
      status: 'complete',
      reviewVerdict: 'changes_requested',
      summary: 'Retry count is 2, expected 3.',
    });
    assert.equal(done.status, 200);

    const task = await h.task();
    assert.equal(task.columnId, 'in-progress');
    assert.equal(task.agentStatus, 'idle');
    assert.equal(task.summary, 'Retry count is 2, expected 3.');
    assert.equal((await h.events()).some((content) => content.includes('Retry count is 2, expected 3.')), true);

    // Re-running from In Progress is a normal implementation run again, and
    // the completed review released its claim so the task is claimable.
    await h.requeue();
    const { task: rerun } = await h.claim();
    assert.equal(rerun.mode, undefined);
  });
});

test('a review without a verdict fails instead of silently passing', async () => {
  await withHarness('review', async (h) => {
    await h.run();
    const { claimToken } = await h.claim();

    assert.equal((await h.complete(claimToken, { status: 'complete' })).status, 200);

    const task = await h.task();
    assert.equal(task.columnId, 'review');
    assert.equal(task.agentStatus, 'failed');
    assert.match(task.summary ?? '', /without a verdict/);
  });
});

test('an invalid review verdict is rejected', async () => {
  await withHarness('review', async (h) => {
    await h.run();
    const { claimToken } = await h.claim();
    assert.equal((await h.complete(claimToken, { status: 'complete', reviewVerdict: 'maybe' })).status, 400);
  });
});

test('a run started from In Progress is a normal implementation run', async () => {
  await withHarness('in-progress', async (h) => {
    await h.run();
    const { task, claimToken } = await h.claim();
    assert.equal(task.mode, undefined);
    assert.equal((await h.complete(claimToken, { status: 'complete' })).status, 200);
    assert.equal((await h.task()).agentStatus, 'complete');
  });
});
