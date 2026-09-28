import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type Database from 'better-sqlite3';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteWorkerRepository } from '../src/repositories/sqlite-workers.js';
import { getAllTasksAcrossProjects, shouldRecoverStandaloneTaskAsFailed } from '../src/startup-recovery.js';
import type { Project } from '../src/types.js';

// SHOULD-FIX 6: an UNANSWERED pending task (agent_status=awaiting_clarification
// with a real clarification_request, columnId=pending) is the exact state the
// "park on question" feature introduces — it must survive both a worker-sweep
// tick and a server restart's startup recovery: neither marked failed nor
// reset/resurrected to some other status.

async function withDatabase(run: (db: Database.Database, cleanup: () => void) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-pending-survives-'));
  const originalDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(dir, 'board.db');
  try {
    const { initDatabase } = await import(`../src/db.js?worker-pending-survives=${Date.now()}-${Math.random()}`);
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

test('an unanswered pending task survives a worker-sweep tick and startup recovery', async () => {
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
        id: 'task-parked',
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
      await tasks.assignToWorker('task-parked', 'worker-1');
      await tasks.requestRun('task-parked', Date.now());
      const claimHash = crypto.createHash('sha256').update('claim-token').digest('hex');
      const now = Date.now();
      await tasks.claimWorkerTask('task-parked', 'worker-1', claimHash, now, 60_000);
      const parked = await tasks.parkWorkerTaskForClarification('task-parked', 'worker-1', claimHash, now, {
        requestId: 'req-1',
        sessionId: 'ses_1',
        prompt: 'Which API version should the client target?',
        timestamp: now,
      });
      assert.ok(parked);
      assert.equal(parked.columnId, 'pending');
      assert.equal(parked.agentStatus, 'awaiting_clarification');

      // (a) One worker-sweep tick: index.ts fails every task returned by
      // getAssignedWorkerTasks (for offline workers) and getExpiredWorkerTasks
      // (for any expired lease). A properly parked task must not appear in
      // either query — the sweep has nothing to act on for it.
      const laterNow = now + 120_000; // well past a normal WORKER_TASK_LEASE_MS
      const assignedToOfflineWorker = await tasks.getAssignedWorkerTasks(['worker-1']);
      assert.deepEqual(assignedToOfflineWorker.map((t) => t.id), [], 'a parked task must not be failed by the worker-offline sweep');
      const expiredLeaseTasks = await tasks.getExpiredWorkerTasks(laterNow);
      assert.deepEqual(expiredLeaseTasks.map((t) => t.id), [], 'a parked task must not be failed by the expired-lease sweep');

      // (b) Startup recovery: shouldRecoverStandaloneTaskAsFailed must not
      // flag it (it has a real clarification_request), so it is excluded from
      // the orphaned-tasks recovery pass entirely.
      const projectRepo = {
        async getAllWithCounts(): Promise<Project[]> {
          return [{ id: 'default', name: 'Default', isDefault: true, createdAt: 1, updatedAt: 1 }];
        },
      };
      const allTasks = await getAllTasksAcrossProjects(projectRepo, tasks);
      const orphaned = allTasks.filter((t) => shouldRecoverStandaloneTaskAsFailed(t.agentStatus, !!t.clarificationRequest));
      assert.deepEqual(orphaned.map((t) => t.id), [], 'a parked task must not be recovered as failed at startup');

      // Neither pass touched the row: it is not failed, not reset to idle,
      // still parked with the same request.
      const after = await tasks.getById('task-parked');
      assert.equal(after?.agentStatus, 'awaiting_clarification');
      assert.equal(after?.columnId, 'pending');
      assert.equal(after?.clarificationRequest?.requestId, 'req-1');
      assert.equal(after?.completedAt, undefined);
    } finally {
      cleanup();
    }
  });
});
