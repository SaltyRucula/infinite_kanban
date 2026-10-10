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
import { createTaskRouter } from '../src/routes/tasks.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteWorkerRepository } from '../src/repositories/sqlite-workers.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
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

const projectRepo: ProjectRepository = {
  async getAllWithCounts() { return []; },
  async getById(id: string) { return id === 'default' ? { id: 'default', name: 'Default', isDefault: true, createdAt: 1, updatedAt: 1 } : undefined; },
  async getDefault() { return { id: 'default', name: 'Default', isDefault: true, createdAt: 1, updatedAt: 1 }; },
  async resolve() { return []; },
  async create() { throw new Error('not implemented'); },
  async update() { return undefined; },
  async hasTasksOrGroups() { return false; },
  async delete() { return false; },
};

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
  moveColumn(columnId: ColumnId): Promise<void>;
  patch(body: Record<string, unknown>): Promise<Response>;
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
    acceptedProjectIds: ['default'],
    acceptedLabels: [],
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
  app.use('/api/tasks', createTaskRouter(tasks, agentManager, projectRepo));
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
    async moveColumn(columnId) {
      // Bypasses PATCH /api/tasks validation deliberately: simulates a
      // concurrent column move racing an in-flight worker run.
      await tasks.update(taskId, { columnId });
    },
    async patch(body) {
      return fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
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

test('a changes_requested settlement does not leave the task self-claimable (BLOCKER: unattended auto-run)', async () => {
  await withHarness('review', async (h) => {
    await h.run();
    const { claimToken } = await h.claim();

    const done = await h.complete(claimToken, {
      status: 'complete',
      reviewVerdict: 'changes_requested',
      summary: 'Retry count is 2, expected 3.',
    });
    assert.equal(done.status, 200);

    // completeWorkerTask() clears the claim but a stale run_requested_at
    // combined with agentStatus 'idle' exactly matches the worker-assignment
    // predicate, letting the same task be re-claimed and re-run unattended
    // within one poll cycle. It must not reappear until a human re-runs it.
    assert.deepEqual(await h.assignments(), []);
  });
});

// BLOCKER 1 (round 2): the previous fix only cleared run_requested_at inside
// settleReviewRun's changes_requested branch, which patches one symptom but
// not the root cause. completeWorkerTask() itself must clear
// run_requested_at on EVERY completion (including a passing review, which
// leaves the task sitting in Review with agentStatus 'complete'), because a
// human dragging the card via the real PATCH route unconditionally resets
// agentStatus to 'idle' and update() re-persists whatever run_requested_at
// the row still has. This must be verified through the real route path (not
// by calling assignments()/repository methods directly), because that is
// exactly the path the previous regression test missed.
test('a passing review settlement does not become worker-claimable after a human drags the card back to In Progress via PATCH (BLOCKER 1, round 2)', async () => {
  await withHarness('review', async (h) => {
    await h.run();
    const { claimToken } = await h.claim();

    const done = await h.complete(claimToken, { status: 'complete', reviewVerdict: 'pass', summary: 'All requirements met.' });
    assert.equal(done.status, 200);

    const reviewed = await h.task();
    assert.equal(reviewed.columnId, 'review');
    assert.equal(reviewed.agentStatus, 'complete');

    // The exact exploit path: PATCH /api/tasks/:id {columnId:'in-progress'}
    // unconditionally sets agentStatus back to 'idle'.
    const patched = await h.patch({ columnId: 'in-progress' });
    assert.equal(patched.status, 200);

    const moved = await h.task();
    assert.equal(moved.columnId, 'in-progress');
    assert.equal(moved.agentStatus, 'idle');

    // Must NOT match getWorkerAssignments' claim predicate — if
    // run_requested_at was left set by completeWorkerTask(), it would be
    // re-claimed and silently re-run within one poll cycle.
    assert.deepEqual(await h.assignments(), []);
  });
});

test('a done review settlement does not become worker-claimable after a human drags the card back to In Progress via PATCH (BLOCKER 1, round 2)', async () => {
  await withHarness('review', async (h) => {
    await h.run();
    const { claimToken } = await h.claim();

    const done = await h.complete(claimToken, { status: 'complete', reviewVerdict: 'pass', summary: 'All requirements met.' });
    assert.equal(done.status, 200);

    const toDone = await h.patch({ columnId: 'done' });
    assert.equal(toDone.status, 200);

    const patched = await h.patch({ columnId: 'in-progress' });
    assert.equal(patched.status, 200);

    const moved = await h.task();
    assert.equal(moved.columnId, 'in-progress');
    assert.equal(moved.agentStatus, 'idle');
    assert.deepEqual(await h.assignments(), []);
  });
});

// A compliant worker's reviewResult() never sends {status: 'complete'} without
// a reviewVerdict — a missing verdict is always reported as {status: 'failed'}
// (see review-mode.ts). That realistic payload is used here; reviewVerdict
// presence (not columnId) now decides whether a completion is settled as a
// review (see the SHOULD-FIX-4 test below for why columnId can't be used).
test('a review without a verdict fails instead of silently passing', async () => {
  await withHarness('review', async (h) => {
    await h.run();
    const { claimToken } = await h.claim();

    assert.equal((await h.complete(claimToken, {
      status: 'failed',
      summary: 'Review finished without a verdict',
      error: 'review did not end with a REVIEW_VERDICT: line; the result cannot be treated as a pass',
    })).status, 200);

    const task = await h.task();
    assert.equal(task.columnId, 'review');
    assert.equal(task.agentStatus, 'failed');
    assert.match(task.summary ?? '', /without a verdict/);
  });
});

// SHOULD-FIX 6: a buggy or malicious worker is not required to follow
// reviewResult()'s contract — nothing on the wire stops it from sending
// {status:'complete'} for a review run without a reviewVerdict. Before this
// fix that landed as agentStatus 'complete' with the worker's raw summary
// sitting in Review, visually indistinguishable from a genuine pass (no
// "Review passed." event, but also no warning). This restores discriminating
// coverage for that exact case (previously weakened into a {status:'failed'}
// test above, which cannot tell pre-fix and post-fix code apart).
test('a {status: complete} completion without a verdict does not emit a review-only warning based on column state', async () => {
  await withHarness('review', async (h) => {
    await h.run();
    const { claimToken } = await h.claim();

    const done = await h.complete(claimToken, { status: 'complete', summary: 'Looks fine to me.' });
    assert.equal(done.status, 200);

    const task = await h.task();
    assert.equal(task.agentStatus, 'complete');
    assert.equal(task.columnId, 'review');

    const events = await h.events();
    // Must not be reported as a genuine pass...
    assert.equal(events.some((content) => content.startsWith('Review passed.')), false);
    // ...and must not create an error event from a best-effort columnId guess.
    assert.equal(events.some((content) => content.includes('completed without a REVIEW_VERDICT')), false);
  });
});

// BLOCKER regression (merge of the reviewer-role feature into this branch):
// this branch's completeWorkerTask unconditionally forces column_id to
// 'review' whenever status='complete' (see the SQL comment on
// completeWorkerTask), so reading `completed.columnId` — the row state
// AFTER completeWorkerTask ran — to decide whether to emit the defensive
// "completed without a REVIEW_VERDICT while the task was in the Review
// column" warning made the condition true for every successful
// implementation-run completion, not just genuine review-column
// completions. A normal implementation run finishing from In Progress must
// never emit this warning. This test fails against the pre-fix code (which
// reads completed.columnId) and passes once the check reads the
// pre-completion task.columnId instead.
test('a normal implementation run completing from In Progress emits no defensive REVIEW_VERDICT warning (BLOCKER regression)', async () => {
  await withHarness('in-progress', async (h) => {
    await h.run();
    const { task, claimToken } = await h.claim();
    assert.equal(task.mode, undefined);

    const done = await h.complete(claimToken, { status: 'complete', summary: 'Added retry with 3 attempts.' });
    assert.equal(done.status, 200);

    const settled = await h.task();
    assert.equal(settled.agentStatus, 'complete');
    // completeWorkerTask forces column_id to 'review' on every successful
    // completion, so this assertion alone does not discriminate the bug —
    // it documents that behavior. The real assertion is on events below.
    assert.equal(settled.columnId, 'review');

    const events = await h.events();
    assert.equal(
      events.some((content) => content.includes('completed without a REVIEW_VERDICT')),
      false,
      'a normal implementation-run completion must not emit the review-settlement defensive warning',
    );
  });
});

test('an implementation run completing while the task sits in Review is not misfiled as a review (SHOULD-FIX: stable settlement discriminator)', async () => {
  await withHarness('in-progress', async (h) => {
    await h.run();
    const { task, claimToken } = await h.claim();
    assert.equal(task.mode, undefined);

    // Simulate the card being dragged to Review by a human while the worker
    // is still executing the (ordinary, non-review) run it was assigned.
    await h.moveColumn('review');

    const done = await h.complete(claimToken, { status: 'complete', summary: 'Added retry with 3 attempts.' });
    assert.equal(done.status, 200);

    const settled = await h.task();
    // The real implementation summary must survive: it must not be
    // overwritten with "Review finished without a verdict" just because the
    // card now happens to sit in the Review column.
    assert.equal(settled.agentStatus, 'complete');
    assert.equal(settled.summary, 'Added retry with 3 attempts.');
    assert.equal(
      (await h.events()).some((content) => content.includes('completed without a REVIEW_VERDICT')),
      false,
      'the completion payload, not a mid-run column drag, determines review handling',
    );
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
