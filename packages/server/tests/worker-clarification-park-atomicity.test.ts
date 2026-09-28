import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type Database from 'better-sqlite3';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { SqliteWorkerRepository } from '../src/repositories/sqlite-workers.js';
import { shouldRecoverStandaloneTaskAsFailed } from '../src/startup-recovery.js';

// BLOCKER 1 regression: parking a task used to be TWO non-atomic writes
// (completeWorkerTask releasing the claim, then a separate tasks.update
// writing clarification_request). If the second write failed, the row was
// left agent_status='awaiting_clarification' with clarification_request=NULL
// and the claim already released — invisible to every recovery predicate and
// un-answerable via /clarification/resume. These tests pin down (1) that
// parking is now a single atomic repository call, and (2) the defense-in-depth
// recovery predicates that would catch such a row if one ever appeared anyway.

async function withDatabase(run: (db: Database.Database, cleanup: () => void) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-park-atomic-'));
  const originalDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(dir, 'board.db');
  try {
    const { initDatabase } = await import(`../src/db.js?worker-park-atomic=${Date.now()}-${Math.random()}`);
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

test('parkWorkerTaskForClarification atomically sets agent_status, column_id, and clarification_request together', async () => {
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
      const claimHash = crypto.createHash('sha256').update('claim-token').digest('hex');
      const now = Date.now();
      const claimed = await tasks.claimWorkerTask('task-1', 'worker-1', claimHash, now, 60_000);
      assert.ok(claimed);

      // A stale/mismatched claim must be rejected WITHOUT mutating anything —
      // proving the single UPDATE's WHERE clause guards the whole write, not
      // just part of it.
      const wrongHash = crypto.createHash('sha256').update('wrong-token').digest('hex');
      const rejected = await tasks.parkWorkerTaskForClarification('task-1', 'worker-1', wrongHash, now, {
        requestId: 'req-bad',
        sessionId: 'ses_1',
        prompt: 'should not apply',
        timestamp: now,
      });
      assert.equal(rejected, undefined);
      const untouched = await tasks.getById('task-1');
      assert.equal(untouched?.agentStatus, 'planning');
      assert.equal(untouched?.columnId, 'in-progress');
      assert.equal(untouched?.clarificationRequest ?? null, null);

      // The real claim parks agent_status, column_id, and
      // clarification_request together in one write.
      const parked = await tasks.parkWorkerTaskForClarification('task-1', 'worker-1', claimHash, now, {
        requestId: 'req-1',
        sessionId: 'ses_1',
        prompt: 'Which API version should the client target?',
        timestamp: now,
      });
      assert.ok(parked);
      assert.equal(parked.agentStatus, 'awaiting_clarification');
      assert.equal(parked.columnId, 'pending');
      assert.equal(parked.clarificationRequest?.requestId, 'req-1');
      assert.equal(parked.clarificationRequest?.prompt, 'Which API version should the client target?');
      assert.equal(parked.completedAt, undefined);

      // The claim is released exactly like completion does, so a second
      // attempt with the now-stale claim token fails cleanly instead of
      // double-applying — and critically, it does NOT clear
      // clarification_request (there is no separate second write to fail).
      const second = await tasks.parkWorkerTaskForClarification('task-1', 'worker-1', claimHash, now, {
        requestId: 'req-2',
        sessionId: 'ses_1',
        prompt: 'a different question',
        timestamp: now,
      });
      assert.equal(second, undefined);
      const stillParked = await tasks.getById('task-1');
      assert.equal(stillParked?.agentStatus, 'awaiting_clarification');
      assert.equal(stillParked?.clarificationRequest?.requestId, 'req-1');
    } finally {
      cleanup();
    }
  });
});

test('defense in depth: a stranded awaiting_clarification row with no clarification_request is recoverable', async () => {
  await withDatabase(async (db, cleanup) => {
    try {
      const tasks = new SqliteTaskRepository(db);
      await tasks.create({
        id: 'task-stranded',
        projectId: 'default',
        title: 'Stranded task',
        description: '',
        priority: 'medium',
        columnId: 'pending',
        agentStatus: 'awaiting_clarification',
        agentType: 'opencode',
        createdAt: Date.now(),
        labels: [],
      });
      // Simulate the historical bug directly at the row level: agent_status
      // and column_id landed (from the first write) but clarification_request
      // never did (the second write failed), and the claim was already
      // released — exactly the shape BLOCKER 1 describes.
      db.prepare(`UPDATE tasks SET assigned_worker_id = 'worker-1', worker_claim_token_hash = NULL, worker_lease_expires_at = NULL WHERE id = 'task-stranded'`).run();

      const now = Date.now();
      const expired = await tasks.getExpiredWorkerTasks(now);
      assert.ok(expired.some((t) => t.id === 'task-stranded'), 'getExpiredWorkerTasks must recover a stranded park');

      const assigned = await tasks.getAssignedWorkerTasks(['worker-1']);
      assert.ok(assigned.some((t) => t.id === 'task-stranded'), 'getAssignedWorkerTasks must recover a stranded park for an offline worker');

      const row = await tasks.getById('task-stranded');
      assert.ok(row);
      assert.equal(shouldRecoverStandaloneTaskAsFailed(row.agentStatus, !!row.clarificationRequest), true);
    } finally {
      cleanup();
    }
  });
});

test('a properly parked task (with a clarification_request) is NOT swept up by the defense-in-depth predicates', async () => {
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
        id: 'task-ok',
        projectId: 'default',
        title: 'Fine task',
        description: '',
        priority: 'medium',
        columnId: 'in-progress',
        agentStatus: 'planning',
        agentType: 'opencode',
        createdAt: Date.now(),
        labels: [],
      });
      await tasks.assignToWorker('task-ok', 'worker-1');
      await tasks.requestRun('task-ok', Date.now());
      const claimHash = crypto.createHash('sha256').update('claim-token').digest('hex');
      const now = Date.now();
      await tasks.claimWorkerTask('task-ok', 'worker-1', claimHash, now, 60_000);
      const parked = await tasks.parkWorkerTaskForClarification('task-ok', 'worker-1', claimHash, now, {
        requestId: 'req-1',
        sessionId: 'ses_1',
        prompt: 'Which environment?',
        timestamp: now,
      });
      assert.ok(parked);

      const expired = await tasks.getExpiredWorkerTasks(now + 1);
      assert.equal(expired.some((t) => t.id === 'task-ok'), false);
      const assigned = await tasks.getAssignedWorkerTasks(['worker-1']);
      assert.equal(assigned.some((t) => t.id === 'task-ok'), false);
      assert.equal(shouldRecoverStandaloneTaskAsFailed(parked.agentStatus, !!parked.clarificationRequest), false);
    } finally {
      cleanup();
    }
  });
});
