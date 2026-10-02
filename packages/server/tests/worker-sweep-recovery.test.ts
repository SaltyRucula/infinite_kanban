import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task } from '../src/types.js';
import { failStrandedWorkerTask } from '../src/worker-sweep-recovery.js';

const task: Task = {
  id: 'stranded-task',
  projectId: 'default',
  title: 'Stranded task',
  description: '',
  priority: 'medium',
  columnId: 'pending',
  agentStatus: 'executing',
  agentType: 'opencode',
  createdAt: 1,
  assignedWorkerId: 'worker-1',
  runRequestedAt: 2,
  runClaimedAt: 3,
  clarificationRequest: { requestId: 'request-1', prompt: 'Question?', timestamp: 4 },
  clarificationAnswer: { requestId: 'request-1', answer: 'Answer', timestamp: 5 },
};

test('worker sweep clears durable run requests before a stranded task can be moved back to In Progress', async () => {
  let updates: Partial<Task> | undefined;
  let clearedSessions = false;
  let clearedCommands = false;
  let broadcasted: Task | undefined;

  await failStrandedWorkerTask(
    task,
    100,
    {
      async update(_id, value) {
        updates = value;
        return { ...task, ...value };
      },
    },
    {
      async clearTaskSessions() { clearedSessions = true; },
      async clearTaskCommands() { clearedCommands = true; },
    },
    (value) => { broadcasted = value; },
  );

  assert.deepEqual(updates, {
    agentStatus: 'failed',
    completedAt: 100,
    summary: 'worker_offline',
    runRequestedAt: undefined,
    runClaimedAt: undefined,
    clarificationRequest: null,
    clarificationAnswer: null,
    columnId: 'in-progress',
  });
  assert.equal(clearedSessions, true);
  assert.equal(clearedCommands, true);
  assert.equal(broadcasted?.runRequestedAt, undefined);
});
