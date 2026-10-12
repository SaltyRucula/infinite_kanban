import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteWorkflowStore, type BoardWorkflowRun } from '../src/repositories/workflow-store.js';
import { BoardWorkflowCoordinator } from '../src/services/board-workflow.js';
import type { Task, A2AAgent } from '../src/types.js';

const revision = 'a'.repeat(40);
const agent: A2AAgent = {
  id: 'implementer', name: 'Implementer', description: '', version: 'test',
  agentCardUrl: 'http://localhost:4100/.well-known/agent-card.json',
  endpoint: 'http://localhost:4100/a2a/v1', protocolVersion: '1.0', enabled: true,
  createdAt: 1, updatedAt: 1, lastValidatedAt: 1,
  projectAccess: [{ agentId: 'implementer', projectId: 'p', roles: ['implementation'], createdAt: 1, updatedAt: 1 }],
  skills: [{ id: 'execution', name: 'Execution', tags: ['execution:v1', 'repository:github.com/o/r', 'consent:p'] }],
};

function fixture(t: test.TestContext, roster: A2AAgent[] = []) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const store = new SqliteWorkflowStore(db);
  const rows = new Map<string, Task>();
  const addTask = (id: string, changes: Partial<Task> = {}) => {
    const task: Task = {
      id, projectId: 'p', title: 'Do it', description: 'Requirements',
      columnId: 'backlog', agentStatus: 'idle', agentType: 'opencode',
      priority: 'medium', labels: [], createdAt: 1, ...changes,
    };
    rows.set(id, task);
    return task;
  };
  addTask('t');
  const tasks = {
    getById: async (id: string) => rows.get(id),
    update: async (id: string, changes: Partial<Task>) => {
      const task = rows.get(id);
      if (!task) return undefined;
      const updated = { ...task, ...changes };
      rows.set(id, updated);
      return updated;
    },
  };
  // Startup repair must never perform endpoint IO, including polling uncertain sends.
  const executor = t.mock.fn(() => { throw new Error('unexpected endpoint IO'); });
  const make = () => new BoardWorkflowCoordinator(store, tasks, { getAll: async () => roster }, executor);
  return { store, tasks, rows, addTask, executor, make };
}

test('an escalated run projects to backlog with its failure reason', async (t) => {
  const f = fixture(t);
  const run = await f.make().start('t', { repository: 'https://github.com/o/r', baseRevision: revision });
  assert.equal(run.phase, 'escalated');
  assert.equal(f.rows.get('t')?.columnId, 'backlog');
  assert.equal(f.rows.get('t')?.agentStatus, 'failed');
  assert.equal(f.rows.get('t')?.summary, `Workflow escalated: ${run.diagnostics.at(-1)!.reason}`);
  assert.match(f.rows.get('t')!.summary!, /no eligible implementation endpoint/);
  assert.equal(f.executor.mock.callCount(), 0);
});

test('a dispatch_uncertain run projects to backlog with its failure reason', async (t) => {
  const f = fixture(t, [agent]);
  const run = await f.make().start('t', { repository: 'https://github.com/o/r', baseRevision: revision });
  assert.equal(run.phase, 'dispatch_uncertain');
  assert.equal(f.rows.get('t')?.columnId, 'backlog');
  assert.equal(f.rows.get('t')?.agentStatus, 'failed');
  assert.equal(f.rows.get('t')?.summary, `Workflow dispatch_uncertain: ${run.diagnostics.at(-1)!.reason}`);
  assert.match(f.rows.get('t')!.summary!, /uncertain dispatch/);
  assert.equal(f.executor.mock.callCount(), 1);
});

async function persistRun(f: ReturnType<typeof fixture>, taskId: string, phase: BoardWorkflowRun['phase']) {
  const reason = 'original escalation reason';
  const run: BoardWorkflowRun = {
    id: `run-${taskId}`, taskId, projectId: 'p', version: 0, phase,
    repository: 'https://github.com/o/r', baseRevision: revision,
    requirements: 'Requirements', requiredCapabilities: [],
    policy: { autoFinish: false, maxRounds: 3, maxDispatches: 6, deadline: Date.now() + 3600000, requiredChecks: [] },
    assignments: [], diagnostics: [{ at: 1, category: 'dispatch', reason }],
    projectedPhase: phase, projectedKey: `${phase}|1|${reason}||`,
  };
  await f.store.save(run, 0);
  return run;
}

test('startup reconciliation repairs cached stuck projections once, preserving tasks and runs otherwise', async (t) => {
  const f = fixture(t);
  for (const phase of ['escalated', 'dispatch_uncertain'] as const) {
    const summary = `Workflow ${phase}: original escalation reason`;
    const original = f.addTask(phase, { columnId: 'in-progress', agentStatus: 'failed', summary });
    const run = await persistRun(f, phase, phase);
    const restarted = f.make();
    const writes = t.mock.method(f.tasks, 'update');
    const saves = t.mock.method(f.store, 'save');
    await restarted.reconcileFailedProjections();
    assert.deepEqual(f.rows.get(phase), { ...original, columnId: 'backlog', agentStatus: 'failed' });
    assert.deepEqual(await f.store.get(phase), run, 'repair must not mutate or restart the workflow');
    assert.equal(writes.mock.callCount(), 1);
    assert.equal(saves.mock.callCount(), 0);
    await restarted.reconcileFailedProjections();
    await f.make().reconcileFailedProjections();
    assert.equal(writes.mock.callCount(), 1, 'repeated startup repair must not write again');
    assert.equal(f.executor.mock.callCount(), 0);
    writes.mock.restore();
    saves.mock.restore();
  }
});

test('startup reconciliation leaves live runs, other columns, missing tasks and tasks without workflows untouched', async (t) => {
  const f = fixture(t);
  for (const phase of ['implementing', 'reviewing', 'awaiting_approval', 'done', 'canceled'] as const) {
    f.addTask(phase, { columnId: 'in-progress', agentStatus: 'executing', summary: 'existing work' });
    await persistRun(f, phase, phase);
  }
  for (const phase of ['escalated', 'dispatch_uncertain'] as const) {
    for (const columnId of ['backlog', 'review', 'done'] as const) {
      const id = `${phase}-${columnId}`;
      f.addTask(id, { columnId, agentStatus: 'failed', summary: 'existing summary' });
      await persistRun(f, id, phase);
    }
  }
  f.addTask('no-workflow', { columnId: 'in-progress', agentStatus: 'failed', summary: 'legacy failure' });
  await persistRun(f, 'missing-task', 'escalated');
  const before = [...f.rows.entries()];
  const runs = await f.store.list();
  const writes = t.mock.method(f.tasks, 'update');
  await f.make().reconcileFailedProjections();
  assert.deepEqual([...f.rows.entries()], before);
  assert.deepEqual(await f.store.list(), runs);
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(f.executor.mock.callCount(), 0);
});
