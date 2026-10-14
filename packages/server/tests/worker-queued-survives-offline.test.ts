import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type Database from 'better-sqlite3';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteWorkerRepository } from '../src/repositories/sqlite-workers.js';
import { getAllTasksAcrossProjects, recoverOrphanedStandaloneTasks } from '../src/startup-recovery.js';
import { dispatchPendingRuns } from '../src/run-dispatcher.js';
import type { Project } from '../src/types.js';

// Regression test for GitHub issue #127: a task that is run-requested but
// NOT YET CLAIMED by its assigned worker used to be indistinguishable from a
// task abandoned mid-run, because getAssignedWorkerTasks matched on
// agent_status IN ('planning','executing') alone. Sequence that reproduced
// the bug:
//
//   t=0   worker online, heartbeating
//   t=0   human presses Run -> agentStatus='queued' (was 'planning'),
//         run_requested_at set, no claim yet (worker_claim_token_hash NULL)
//   t=1   worker goes offline (laptop lid closed) before polling/claiming
//   t<=60s sweep: markOffline() -> getAssignedWorkerTasks() ->
//         failStrandedWorkerTask() used to fail the task with
//         summary='worker_offline' even though nothing was ever abandoned.
//
// The fix: a fresh run-request sets agentStatus='queued', and
// getAssignedWorkerTasks only returns genuinely claimed tasks
// (worker_claim_token_hash IS NOT NULL). A queued task must wait
// indefinitely until claimed or explicitly cancelled by a human.

async function withDatabase(run: (db: Database.Database, cleanup: () => void) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-queued-survives-'));
  const originalDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(dir, 'board.db');
  try {
    const { initDatabase } = await import(`../src/db.js?worker-queued-survives=${Date.now()}-${Math.random()}`);
    const db = initDatabase() as Database.Database;
    await run(db, () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  } finally {
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
  }
}

test('a queued-but-unclaimed task survives its worker going offline (the exact #127 sequence)', async () => {
  await withDatabase(async (db, cleanup) => {
    try {
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

      // t=0: task created, assigned to worker-1 (still idle, not yet run).
      await tasks.create({
        id: 'task-queued',
        projectId: 'default',
        title: 'Build client',
        description: 'Build the API client',
        priority: 'medium',
        columnId: 'in-progress',
        agentStatus: 'idle',
        agentType: 'opencode',
        createdAt: Date.now(),
        labels: [],
      });
      await tasks.assignToWorker('task-queued', 'worker-1');

      // Human presses Run: this is exactly what routes/agent.ts's /:id/run
      // handler does for a worker-assigned task — requestRun() followed by
      // agentStatus='queued' (NOT 'planning'). No claim has happened yet.
      await tasks.requestRun('task-queued', Date.now());
      const queued = await tasks.update('task-queued', { agentStatus: 'queued', startedAt: undefined, completedAt: undefined });
      assert.equal(queued?.agentStatus, 'queued');
      assert.equal(queued?.runRequestedAt != null, true);
      assert.equal(queued?.workerClaimTokenHash ?? null, null, 'no claim has happened yet');

      // t=1: the worker never polled/claimed before going offline. This is
      // the exact call index.ts's workerSweepInterval makes for every worker
      // markOffline() returns as having flipped online -> offline.
      const assignedToOfflineWorker = await tasks.getAssignedWorkerTasks(['worker-1']);
      assert.deepEqual(
        assignedToOfflineWorker.map((t) => t.id),
        [],
        'a queued-but-unclaimed task must NOT be returned by getAssignedWorkerTasks for an offline worker',
      );

      // The lease-expiry sweep must also leave it alone — it never had a
      // lease to expire.
      const muchLater = Date.now() + 10 * 60_000;
      const expired = await tasks.getExpiredWorkerTasks(muchLater);
      assert.deepEqual(
        expired.map((t) => t.id),
        [],
        'a queued-but-unclaimed task must NOT be returned by getExpiredWorkerTasks',
      );

      // The task must be completely untouched: still queued, not failed,
      // no worker_offline summary, run request still intact so the worker
      // can claim it whenever it comes back online.
      const after = await tasks.getById('task-queued');
      assert.equal(after?.agentStatus, 'queued');
      assert.equal(after?.summary ?? null, null);
      assert.equal(after?.completedAt, undefined);
      assert.equal(after?.runRequestedAt != null, true);

      // When the worker (or a replacement) eventually comes back and polls,
      // the task must still be claimable: claimWorkerTask promotes
      // queued -> planning.
      const claimHash = crypto.createHash('sha256').update('claim-token').digest('hex');
      const claimed = await tasks.claimWorkerTask('task-queued', 'worker-1', claimHash, Date.now(), 60_000);
      assert.ok(claimed, 'a queued task must still be claimable after surviving the offline sweep');
      assert.equal(claimed?.agentStatus, 'planning');
    } finally {
      cleanup();
    }
  });
});

test('a queued-but-unclaimed task survives startup recovery (server restart)', async () => {
  await withDatabase(async (db, cleanup) => {
    try {
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
        id: 'task-queued-restart',
        projectId: 'default',
        title: 'Build client',
        description: '',
        priority: 'medium',
        columnId: 'in-progress',
        agentStatus: 'idle',
        agentType: 'opencode',
        createdAt: Date.now(),
        labels: [],
      });
      await tasks.assignToWorker('task-queued-restart', 'worker-1');
      await tasks.requestRun('task-queued-restart', Date.now());
      await tasks.update('task-queued-restart', { agentStatus: 'queued', startedAt: undefined, completedAt: undefined });

      // (a) The real durable-run dispatcher (used both at startup and on the
      // recurring 15s interval in index.ts) must skip it: it is
      // assignedWorkerId-owned, not a standalone pending run to re-dispatch
      // in-process.
      const dispatched = await dispatchPendingRuns({
        taskRepo: tasks,
        isTaskRunning: () => false,
        dispatchTask: async () => { throw new Error('must never dispatch a worker-owned task in-process'); },
      }, { staleBefore: Date.now() });
      assert.deepEqual(dispatched.map((t) => t.id), []);

      // (b) The real startup-recovery caller (recoverOrphanedStandaloneTasks,
      // same as index.ts) must not touch it either — it is neither
      // planning/executing nor a corrupted awaiting_clarification row.
      const projectRepo = {
        async getAllWithCounts(): Promise<Project[]> {
          return [{ id: 'default', name: 'Default', isDefault: true, createdAt: 1, updatedAt: 1 }];
        },
      };
      const allTasks = await getAllTasksAcrossProjects(projectRepo, tasks);
      const orphaned = await recoverOrphanedStandaloneTasks(allTasks, new Set(), { taskRepo: tasks, workerRepo: workers });
      assert.deepEqual(orphaned.map((t) => t.id), [], 'a queued task must not be recovered as failed at startup');

      const after = await tasks.getById('task-queued-restart');
      assert.equal(after?.agentStatus, 'queued');
      assert.equal(after?.completedAt, undefined);
    } finally {
      cleanup();
    }
  });
});

test('revoking a worker (explicit human action) DOES fail a queued task assigned to it, unlike the automatic sweeps', async () => {
  await withDatabase(async (db, cleanup) => {
    try {
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
        id: 'task-queued-revoked',
        projectId: 'default',
        title: 'Build client',
        description: '',
        priority: 'medium',
        columnId: 'in-progress',
        agentStatus: 'idle',
        agentType: 'opencode',
        createdAt: Date.now(),
        labels: [],
      });
      await tasks.assignToWorker('task-queued-revoked', 'worker-1');
      await tasks.requestRun('task-queued-revoked', Date.now());
      await tasks.update('task-queued-revoked', { agentStatus: 'queued', startedAt: undefined, completedAt: undefined });

      const released = await tasks.revokeWorkerAssignments('worker-1', Date.now());
      assert.deepEqual(released.map((t) => t.id), ['task-queued-revoked']);

      const after = await tasks.getById('task-queued-revoked');
      assert.equal(after?.agentStatus, 'failed');
      assert.equal(after?.summary, 'worker_revoked');
      assert.equal(after?.assignedWorkerId ?? null, null);
      assert.equal(after?.runRequestedAt, undefined, 'run_requested_at must be cleared, or this row would become an unpickable orphan');
    } finally {
      cleanup();
    }
  });
});
