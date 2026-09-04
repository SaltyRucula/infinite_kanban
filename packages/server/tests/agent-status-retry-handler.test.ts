import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import { makeRetryAwareStatusHandler } from '../src/routes/helpers.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    title: 'Jira task',
    description: '',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'executing',
    createdAt: 1,
    externalSource: 'jira',
    ...overrides,
  };
}

function makeFakeRepo(task: Task) {
  let current = { ...task };
  const updates: Array<Partial<Task>> = [];
  const clearedRunIds: string[] = [];
  return {
    updates,
    clearedRunIds,
    repo: {
      async getById(id: string) {
        return id === current.id ? current : undefined;
      },
      async update(id: string, patch: Partial<Task>) {
        updates.push(patch);
        if (id !== current.id) return undefined;
        current = { ...current, ...patch };
        return current;
      },
      async clearRun(id: string) {
        clearedRunIds.push(id);
        return task;
      },
    } as unknown as TaskRepository,
  };
}

test('makeRetryAwareStatusHandler clears the run lease and schedules exactly one retry for a transient Jira failure', async () => {
  const task = makeTask();
  const { repo, updates, clearedRunIds } = makeFakeRepo(task);
  const scheduled: Array<{ fn: () => void; delayMs: number }> = [];

  const handler = makeRetryAwareStatusHandler(repo, {} as AgentManager, task, {
    scheduleRetry: (fn, delayMs) => { scheduled.push({ fn, delayMs }); },
  });

  await handler('failed', 'OpenCode SDK error: fetch failed — server not reachable');

  assert.equal(clearedRunIds.length, 1);
  assert.equal(updates.some((u) => u.agentStatus === 'failed'), true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 30_000);
});

test('makeRetryAwareStatusHandler does not schedule a retry for a non-transient failure', async () => {
  const task = makeTask();
  const { repo } = makeFakeRepo(task);
  const scheduled: Array<() => void> = [];

  const handler = makeRetryAwareStatusHandler(repo, {} as AgentManager, task, {
    scheduleRetry: (fn) => { scheduled.push(fn); },
  });

  await handler('failed', 'Worktree setup failed: Worktree tasks require branchName');

  assert.equal(scheduled.length, 0);
});
