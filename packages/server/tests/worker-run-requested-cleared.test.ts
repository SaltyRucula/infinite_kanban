import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import http from 'node:http';
import type Database from 'better-sqlite3';
import { createTaskRouter } from '../src/routes/tasks.js';
import { createWorkersRouter } from '../src/routes/workers.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteWorkerRepository } from '../src/repositories/sqlite-workers.js';
import { SqliteProjectRepository } from '../src/repositories/sqlite-projects.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import type { ColumnId, AgentStatus, WorkerTaskAssignment } from '../src/types.js';

// BLOCKER regression: neither completeWorkerTask nor
// parkWorkerTaskForClarification cleared run_requested_at. PATCH
// /api/tasks/:id {columnId:'in-progress'} resets agentStatus to 'idle'
// without touching run_requested_at or assignedWorkerId, so a task a human
// merely dragged (out of Review, or out of Pending instead of answering)
// would immediately match getWorkerAssignments/claimWorkerTask again and the
// worker would silently re-run it with no explicit Run action.

const noopAgentManager = { isRunning: () => false } as unknown as AgentManager;

async function withHarness(callback: (harness: {
  readonly baseUrl: string;
  claimAndAssign(taskId: string, columnId: ColumnId, agentStatus: AgentStatus): Promise<string>;
  complete(taskId: string, claimToken: string, body: Record<string, unknown>): Promise<Response>;
  patch(taskId: string, body: Record<string, unknown>): Promise<Response>;
  assignments(): Promise<readonly WorkerTaskAssignment[]>;
}) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-run-requested-'));
  const originalDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(dir, 'board.db');
  let db: Database.Database;
  try {
    const { initDatabase } = await import(`../src/db.js?worker-run-requested=${Date.now()}-${Math.random()}`);
    db = initDatabase() as Database.Database;
  } finally {
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
  }

  const tasks = new SqliteTaskRepository(db);
  const workers = new SqliteWorkerRepository(db);
  const projects = new SqliteProjectRepository(db);
  await workers.register({
    id: 'worker-1',
    name: 'worker',
    tokenHash: crypto.createHash('sha256').update('worker-token').digest('hex'),
    agentTypes: ['opencode'],
    maxConcurrentTasks: 1,
    registeredAt: Date.now(),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/workers', createWorkersRouter(tasks, workers));
  app.use('/api/tasks', createTaskRouter(tasks, noopAgentManager, projects));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const workerHeaders = { authorization: 'Bearer worker-token', 'content-type': 'application/json' };

  const claimAndAssign = async (taskId: string, columnId: ColumnId, agentStatus: AgentStatus): Promise<void> => {
    await tasks.create({
      id: taskId,
      projectId: 'default',
      title: 'Task',
      description: '',
      priority: 'medium',
      columnId,
      agentStatus,
      agentType: 'opencode',
      createdAt: Date.now(),
      labels: [],
    });
    await tasks.assignToWorker(taskId, 'worker-1');
    await tasks.requestRun(taskId, Date.now());
    const claimResponse = await fetch(`${baseUrl}/api/workers/me/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: workerHeaders,
    });
    assert.equal(claimResponse.status, 200);
    return (await claimResponse.json() as { claimToken: string }).claimToken;
  };

  try {
    await callback({
      baseUrl,
      claimAndAssign,
      complete: (taskId, claimToken, body) => fetch(`${baseUrl}/api/workers/me/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: { ...workerHeaders, 'x-worker-claim': claimToken },
        body: JSON.stringify(body),
      }),
      patch: (taskId, body) => fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      assignments: async () => {
        const response = await fetch(`${baseUrl}/api/workers/me/assignments`, { headers: workerHeaders });
        return (await response.json() as { tasks: WorkerTaskAssignment[] }).tasks;
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a task completed by a worker does not self-start after being dragged Review -> In Progress', async () => {
  await withHarness(async (h) => {
    const claimToken = await h.claimAndAssign('task-complete', 'in-progress', 'planning');

    const completeResponse = await h.complete('task-complete', claimToken, { status: 'complete', summary: 'done' });
    assert.equal(completeResponse.status, 200);

    const patchResponse = await h.patch('task-complete', { columnId: 'in-progress' });
    assert.equal(patchResponse.status, 200);
    const patched = await patchResponse.json() as { agentStatus: string; columnId: string };
    assert.equal(patched.agentStatus, 'idle');
    assert.equal(patched.columnId, 'in-progress');

    const assignments = await h.assignments();
    assert.deepEqual(
      assignments.map((task) => task.id),
      [],
      'a dragged, idle task must not be handed back out to the worker without an explicit Run',
    );
  });
});

test('a task parked in Pending does not self-start after being dragged out to In Progress instead of being answered', async () => {
  await withHarness(async (h) => {
    const claimToken = await h.claimAndAssign('task-parked', 'in-progress', 'planning');

    const pauseResponse = await h.complete('task-parked', claimToken, { status: 'awaiting_input', question: 'Which env?', sessionId: 'ses_1' });
    assert.equal(pauseResponse.status, 200);

    const patchResponse = await h.patch('task-parked', { columnId: 'in-progress' });
    assert.equal(patchResponse.status, 200);
    const patched = await patchResponse.json() as { agentStatus: string; columnId: string };
    assert.equal(patched.agentStatus, 'idle');
    assert.equal(patched.columnId, 'in-progress');

    const assignments = await h.assignments();
    assert.deepEqual(
      assignments.map((task) => task.id),
      [],
      'a task dragged out of Pending instead of being answered must not be handed back out to the worker without an explicit Run',
    );
  });
});
