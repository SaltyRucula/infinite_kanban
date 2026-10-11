import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteWorkflowStore } from '../src/repositories/workflow-store.js';
import { BoardWorkflowCoordinator, type WorkflowEvent } from '../src/services/board-workflow.js';
import type { Task, A2AAgent } from '../src/types.js';
import type { A2AMessageSendParams, A2ARemoteTaskUpdate } from '../src/services/a2a-workflow-client.js';
import type { ExecutionAssignment, ExecutionResult, ExecutionRole } from '@ai-agent-board/shared/execution.js';

const revision = 'a'.repeat(40);
const output = 'b'.repeat(40);

const agents: A2AAgent[] = ['implementer', 'reviewer'].map((id, i) => ({
  id, name: id, description: '', version: 'test',
  agentCardUrl: `http://localhost:${4300 + i}/.well-known/agent-card.json`, enabled: true,
  endpoint: `http://localhost:${4300 + i}/a2a/v1`, protocolVersion: '1.0',
  createdAt: 1, updatedAt: 1, lastValidatedAt: 1,
  projectAccess: [{ agentId: id, projectId: 'p', roles: [i ? 'review' : 'implementation'], createdAt: 1, updatedAt: 1 }],
  skills: [{ id: 'execution', name: 'Execution', tags: ['execution:v1', 'repository:github.com/o/r', 'consent:p', 'review:snapshot'] }],
}));

function fixture() {
  const db = new Database(':memory:');
  const store = new SqliteWorkflowStore(db);
  let task: Task = {
    id: 't', projectId: 'p', title: 'Do it', description: 'Requirements',
    columnId: 'backlog', agentStatus: 'idle', agentType: 'opencode',
    priority: 'medium', labels: [], createdAt: 1,
  };
  const tasks = {
    getById: async () => task,
    update: async (_id: string, changes: Partial<Task>) => { task = { ...task, ...changes }; return task; },
  };
  const updates = new Map<string, A2ARemoteTaskUpdate>();
  const executor = () => ({
    dispatch: async (p: A2AMessageSendParams) => ({ remoteTaskId: p.message.messageId }),
    getUpdate: async (id: string): Promise<A2ARemoteTaskUpdate> => updates.get(id) ?? { state: 'running', artifacts: [] },
    cancel: async () => {},
  });
  const events: WorkflowEvent[] = [];
  const make = () => new BoardWorkflowCoordinator(
    store, tasks, { getAll: async () => agents }, executor, async () => {},
    (event) => { events.push(event); },
  );
  return { db, store, make, events, updates, task: () => task };
}

function result(a: ExecutionAssignment, role: ExecutionRole, verdict: ExecutionResult['verdict'] = 'approved'): ExecutionResult {
  const produced = role === 'implementation' ? output : a.targetRevision!;
  return {
    schemaVersion: 1, taskId: a.taskId, workflowRunId: a.workflowRunId, assignmentId: a.assignmentId,
    attempt: a.attempt, role, endpointId: a.endpointId, revision: produced, summary: 'Checked',
    evidence: [{ check: 'tests', revision: produced, outcome: 'passed', artifact: `urn:sha256:${'c'.repeat(64)}` }],
    ...(role === 'review' ? { verdict, findings: verdict === 'approved' ? [] : [{ severity: 'error' as const, explanation: 'fix it' }] } : {}),
  };
}

/**
 * A failed run with no events renders as "This run did not record an error
 * event" — the board telling the operator it has nothing to show. Every
 * workflow decision must leave a trace on the task.
 */
test('an escalation records why, instead of a failed task with no events', async () => {
  const f = fixture();
  const c = f.make();
  const run = await c.start('t', { repository: 'https://github.com/o/r', baseRevision: revision });
  f.updates.set(run.assignments[0].assignment.assignmentId, { state: 'failed', artifacts: [] });
  await c.tick();

  assert.equal((await c.get('t'))?.phase, 'escalated');
  assert.equal(f.task().agentStatus, 'failed');
  const errors = f.events.filter((event) => event.type === 'error');
  assert.equal(errors.length, 1, JSON.stringify(f.events));
  assert.match(errors[0].content, /execution/);
  assert.match(errors[0].content, /endpoint execution failed/);
  assert.equal(errors[0].taskId, 't');
  f.db.close();
});

test('dispatch, acceptance, review verdict and approval are all visible on the task', async () => {
  const f = fixture();
  const c = f.make();
  let run = await c.start('t', { repository: 'https://github.com/o/r', baseRevision: revision });
  const implementation = run.assignments[0].assignment;
  await c.accept('t', JSON.parse(JSON.stringify(result(implementation, 'implementation'))), implementation.endpointId);
  run = (await c.get('t'))!;
  const review = run.assignments[1].assignment;
  await c.accept('t', JSON.parse(JSON.stringify(result(review, 'review'))), review.endpointId);
  await c.approve('t', output, 'operator');

  const log = f.events.map((event) => event.content).join('\n');
  assert.match(log, /implementation.*implementer/s);
  assert.match(log, new RegExp(output.slice(0, 12)));
  assert.match(log, /review.*reviewer/s);
  assert.match(log, /approved/);
  assert.match(log, /tests/);
  assert.match(log, /operator/);
  assert.ok(f.events.every((event) => event.taskId === 't'));
  f.db.close();
});

test('endpoint progress is relayed once, and survives a restart without replaying', async () => {
  const f = fixture();
  const c = f.make();
  const run = await c.start('t', { repository: 'https://github.com/o/r', baseRevision: revision });
  const id = run.assignments[0].assignment.assignmentId;

  f.updates.set(id, {
    state: 'running', artifacts: [],
    history: [
      { messageId: 'm1', text: 'reading add.cjs', kind: 'tool_call' },
      { messageId: 'm2', text: 'running tests', kind: 'command' },
    ],
  });
  // The dispatch itself is already on the log, so progress follows it.
  const base = f.events.length;
  await c.tick();
  assert.deepEqual(f.events.slice(base).map((event) => event.content), ['reading add.cjs', 'running tests']);
  assert.deepEqual(f.events.slice(base).map((event) => event.type), ['tool_call', 'command']);

  // A second poll must not repeat what has already been relayed.
  await c.tick();
  assert.equal(f.events.length, base + 2);

  // Nor may a fresh coordinator replay the backlog after a restart.
  const restarted = f.make();
  f.updates.set(id, {
    state: 'running', artifacts: [],
    history: [
      { messageId: 'm1', text: 'reading add.cjs', kind: 'tool_call' },
      { messageId: 'm2', text: 'running tests', kind: 'command' },
      { messageId: 'm3', text: 'tests passed', kind: 'command_output' },
    ],
  });
  await restarted.tick();
  assert.equal(f.events.length, base + 3);
  assert.equal(f.events.at(-1)?.content, 'tests passed');
  f.db.close();
});

/**
 * project() ran on every tick for every live run, so a terminal workflow
 * rewrote and rebroadcast identical task state once per second forever. The
 * event feed filled with duplicate "Status: failed" lines until restart.
 */
test('a settled workflow stops rebroadcasting identical task state', async () => {
  const f = fixture();
  const c = f.make();
  const run = await c.start('t', { repository: 'https://github.com/o/r', baseRevision: revision });
  f.updates.set(run.assignments[0].assignment.assignmentId, { state: 'failed', artifacts: [] });
  await c.tick();
  assert.equal((await c.get('t'))?.phase, 'escalated');

  let writes = 0;
  const counted = new BoardWorkflowCoordinator(
    f.store,
    { getById: async () => ({ ...f.task() }), update: async (_id: string, changes: Partial<Task>) => { writes += 1; return { ...f.task(), ...changes }; } },
    { getAll: async () => agents },
    () => ({ dispatch: async () => ({ remoteTaskId: 'x' }), getUpdate: async () => ({ state: 'failed' as const, artifacts: [] }), cancel: async () => {} }),
    async () => {},
    () => {},
  );
  await counted.tick();
  await counted.tick();
  await counted.tick();
  assert.equal(writes, 0, 'a settled workflow must not rewrite the task on every tick');
  f.db.close();
});

test('a coordinator without an event sink still runs', async () => {
  const db = new Database(':memory:');
  const store = new SqliteWorkflowStore(db);
  let task: Task = {
    id: 't', projectId: 'p', title: 'Do it', description: 'Requirements',
    columnId: 'backlog', agentStatus: 'idle', agentType: 'opencode', priority: 'medium', labels: [], createdAt: 1,
  };
  const coordinator = new BoardWorkflowCoordinator(
    store,
    { getById: async () => task, update: async (_id: string, changes: Partial<Task>) => { task = { ...task, ...changes }; return task; } },
    { getAll: async () => agents },
    () => ({ dispatch: async (p: A2AMessageSendParams) => ({ remoteTaskId: p.message.messageId }), getUpdate: async () => ({ state: 'running', artifacts: [] }), cancel: async () => {} }),
    async () => {},
  );
  const run = await coordinator.start('t', { repository: 'https://github.com/o/r', baseRevision: revision });
  assert.equal(run.phase, 'implementing');
  db.close();
});
