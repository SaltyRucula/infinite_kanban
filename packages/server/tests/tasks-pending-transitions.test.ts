import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import express from 'express';
import { createTaskRouter } from '../src/routes/tasks.js';
import type { Task, Project } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'default',
    title: 'Task',
    description: '',
    priority: 'medium',
    columnId: 'pending',
    agentStatus: 'awaiting_clarification',
    agentType: 'opencode',
    createdAt: 1,
    clarificationRequest: {
      requestId: 'req-1',
      sessionId: 'session-1',
      prompt: 'Which branch?',
      timestamp: 1,
      choices: ['main', 'develop'],
    },
    clarificationAnswer: {
      requestId: 'req-1',
      sessionId: 'session-1',
      answer: 'main',
      timestamp: 2,
    },
    ...overrides,
  };
}

function makeProject(): Project {
  return {
    id: 'default',
    name: 'Default',
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
    jiraImportEnabled: false,
    jiraImportIntervalMinutes: 15,
    jiraImportAutoStart: false,
  };
}

function createRepo(task: Task): TaskRepository {
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

function createProjectRepo(project: Project): ProjectRepository {
  return {
    async getAllWithCounts(): Promise<Project[]> { return [project]; },
    async getById(id: string): Promise<Project | undefined> { return id === project.id ? project : undefined; },
    async getDefault(): Promise<Project | undefined> { return project; },
    async resolve(): Promise<Project[]> { return [project]; },
    async create(): Promise<Project> { return project; },
    async update(): Promise<Project | undefined> { return project; },
    async delete(): Promise<boolean> { return false; },
    async hasTasksOrGroups(): Promise<boolean> { return false; },
  };
}

function createManager(running: boolean): AgentManager {
  return {
    isRunning: () => running,
    stopAgent: async () => false,
    startAgent: () => {},
    clearEvents: () => {},
    resetEvents: () => {},
    getAvailableAgents: () => [],
  } as unknown as AgentManager;
}

async function withApp(
  task: Task,
  running: boolean,
  run: (baseUrl: string, getTask: () => Promise<Task | undefined>) => Promise<void>,
): Promise<void> {
  const repo = createRepo(task);
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createTaskRouter(repo, createManager(running), createProjectRepo(makeProject())));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('bind failed');
    await run(`http://127.0.0.1:${address.port}`, () => repo.getById(task.id));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

test('PATCH /api/tasks/:id rejects direct set to pending', async () => {
  await withApp(makeTask({ columnId: 'in-progress', agentStatus: 'executing' }), false, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ columnId: 'pending' }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(String(body.error), /reserved/i);
  });
});

test('PATCH /api/tasks/:id allows pending -> in-progress only when not running and clears clarification fields', async () => {
  await withApp(makeTask(), false, async (baseUrl, getTask) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ columnId: 'in-progress' }),
    });
    assert.equal(response.status, 200);

    const updated = await getTask();
    assert.equal(updated?.columnId, 'in-progress');
    assert.equal(updated?.agentStatus, 'idle');
    assert.equal(updated?.startedAt, undefined);
    assert.equal(updated?.completedAt, undefined);
    assert.equal(updated?.clarificationRequest ?? null, null);
    assert.equal(updated?.clarificationAnswer ?? null, null);
  });
});

test('PATCH /api/tasks/:id rejects pending -> in-progress while session is running', async () => {
  await withApp(makeTask(), true, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ columnId: 'in-progress' }),
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.match(String(body.error), /running/i);
  });
});

test('PATCH /api/tasks/:id rejects pending transitions to backlog/review/done', async () => {
  for (const target of ['backlog', 'review', 'done'] as const) {
    await withApp(makeTask(), false, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/task-1`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ columnId: target }),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.match(String(body.error), /Cannot move from pending/i);
    });
  }
});
