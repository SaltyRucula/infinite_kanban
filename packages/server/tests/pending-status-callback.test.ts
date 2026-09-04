import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import { makeStatusCallback } from '../src/routes/helpers.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'default',
    title: 'Task',
    description: '',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'idle',
    createdAt: 1,
    ...overrides,
  };
}

function makeRepo(task: Task): TaskRepository {
  let current = { ...task };
  return {
    async getAll(): Promise<Task[]> { return [current]; },
    async getById(id: string): Promise<Task | undefined> { return id === current.id ? current : undefined; },
    async getByExternalIdentity(): Promise<Task | undefined> { return undefined; },
    async create(next: Task): Promise<Task> { current = next; return current; },
    async createIdempotent(next: Task): Promise<{ task: Task; created: boolean }> { current = next; return { task: current, created: true }; },
    async requestRun(): Promise<Task | undefined> { return undefined; },
    async claimRun(): Promise<Task | undefined> { return undefined; },
    async clearRun(): Promise<Task | undefined> { return undefined; },
    async getPendingRuns(): Promise<Task[]> { return []; },
    async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
      if (id !== current.id) return undefined;
      current = { ...current, ...updates };
      return current;
    },
    async delete(): Promise<boolean> { return false; },
    async count(): Promise<number> { return 1; },
    async insertEvent(): Promise<void> {},
    async getEventsByTaskId(): Promise<[]> { return []; },
    async deleteEventsByTaskId(): Promise<void> {},
    async getArchivedTasks(): Promise<Task[]> { return []; },
  };
}

test('makeStatusCallback maps clarification status transitions to pending and back to in-progress', async () => {
  const repo = makeRepo(makeTask({ agentStatus: 'executing', columnId: 'in-progress' }));
  const onStatus = makeStatusCallback(repo, 'task-1');

  await onStatus('awaiting_clarification');
  const pending = await repo.getById('task-1');
  assert.equal(pending?.columnId, 'pending');

  await onStatus('executing');
  const resumed = await repo.getById('task-1');
  assert.equal(resumed?.columnId, 'in-progress');
});

test('makeStatusCallback keeps executing transition column unchanged when task is not pending', async () => {
  const repo = makeRepo(makeTask({ agentStatus: 'planning', columnId: 'in-progress' }));
  const onStatus = makeStatusCallback(repo, 'task-1');

  await onStatus('executing');
  const task = await repo.getById('task-1');
  assert.equal(task?.columnId, 'in-progress');
});

test('makeStatusCallback moves failed pending tasks back to in-progress', async () => {
  const repo = makeRepo(makeTask({ agentStatus: 'awaiting_clarification', columnId: 'pending' }));
  const onStatus = makeStatusCallback(repo, 'task-1');

  await onStatus('failed');
  const failed = await repo.getById('task-1');
  assert.equal(failed?.columnId, 'in-progress');
});
