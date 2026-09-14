import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import express from 'express';
import { WebSocket } from 'ws';
import { createAgentRouter } from '../src/routes/agent.js';
import { createTaskRouter } from '../src/routes/tasks.js';
import { createWorkersRouter } from '../src/routes/workers.js';
import { broadcastTaskUpdate, buildTask, normalizeTaskLabels } from '../src/routes/helpers.js';
import { createWSS } from '../src/websocket.js';
import type { Project, Task } from '../src/types.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { Worker, WorkerRepository } from '../src/repositories/worker-types.js';
import type { AgentManager } from '../src/services/agent-manager.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    title: 'Task',
    description: 'desc',
    priority: 'medium',
    columnId: 'backlog',
    agentStatus: 'idle',
    agentType: 'opencode',
    createdAt: 1,
    ...overrides,
  };
}

function makeProject(): Project {
  return {
    id: 'project-1',
    name: 'Project',
    repoPath: '/private/project',
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    jiraImportEnabled: false,
    jiraImportIntervalMinutes: 15,
    jiraImportAutoStart: false,
  };
}

const worker: Worker = {
  id: 'worker-1',
  name: 'Worker',
  status: 'online',
  agentTypes: ['opencode'],
  maxConcurrentTasks: 1,
  registeredAt: 1,
  lastHeartbeatAt: 1,
  updatedAt: 1,
};

function createTaskRepo(initialTasks: readonly Task[] = []): {
  repo: TaskRepository;
  getTasks: () => readonly Task[];
  calls: { requestRun: number; claimRun: number; startAgent: number };
} {
  const tasks = new Map(initialTasks.map((task) => [task.id, task]));
  const workerClaimedTaskIds = new Set<string>();
  const calls = { requestRun: 0, claimRun: 0, startAgent: 0 };
  const repo: TaskRepository = {
    async getAll(): Promise<Task[]> { return [...tasks.values()]; },
    async getById(id: string): Promise<Task | undefined> { return tasks.get(id); },
    async getByExternalIdentity(): Promise<Task | undefined> { return undefined; },
    async create(task: Task): Promise<Task> { tasks.set(task.id, task); return task; },
    async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
      const existing = [...tasks.values()].find((candidate) => candidate.externalKey === task.externalKey && task.externalKey);
      if (existing) return { task: existing, created: false };
      tasks.set(task.id, task);
      return { task, created: true };
    },
    async requestRun(id: string, at: number): Promise<Task | undefined> {
      calls.requestRun += 1;
      const task = tasks.get(id);
      if (!task) return undefined;
      workerClaimedTaskIds.delete(id);
      const updated = { ...task, runRequestedAt: at, runClaimedAt: undefined };
      tasks.set(id, updated);
      return updated;
    },
    async claimRun(id: string, at: number): Promise<Task | undefined> {
      calls.claimRun += 1;
      const task = tasks.get(id);
      if (!task) return undefined;
      if (workerClaimedTaskIds.has(id)) return undefined;
      const updated = { ...task, runClaimedAt: at };
      tasks.set(id, updated);
      return updated;
    },
    async clearRun(): Promise<Task | undefined> { return undefined; },
    async getPendingRuns(): Promise<Task[]> { return []; },
    async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
      const task = tasks.get(id);
      if (!task) return undefined;
      const updated = { ...task, ...updates };
      tasks.set(id, updated);
      return updated;
    },
    async delete(id: string): Promise<boolean> { return tasks.delete(id); },
    async count(): Promise<number> { return tasks.size; },
    async insertEvent(): Promise<void> {},
    async getEventsByTaskId(): Promise<[]> { return []; },
    async deleteEventsByTaskId(): Promise<void> {},
    async getArchivedTasks(): Promise<Task[]> { return []; },
    async assignToWorker(id: string, workerId: string | null): Promise<Task | undefined> {
      const task = tasks.get(id);
      if (!task) return undefined;
      const updated = { ...task, assignedWorkerId: workerId };
      tasks.set(id, updated);
      return updated;
    },
    async getWorkerAssignments(workerId: string): Promise<Task[]> {
      return [...tasks.values()].filter((task) => task.assignedWorkerId === workerId);
    },
    async claimWorkerTask(id: string, workerId: string, claimTokenHash: string, now: number, leaseMs: number): Promise<Task | undefined> {
      const task = tasks.get(id);
      if (!task || task.assignedWorkerId !== workerId || task.runRequestedAt == null || (task.agentStatus !== 'idle' && task.agentStatus !== 'planning')) return undefined;
      const updated = {
        ...task,
        agentStatus: 'planning',
        startedAt: task.startedAt ?? now,
        workerAttempt: (task as Task & { workerAttempt?: number }).workerAttempt ?? 0,
        workerClaimTokenHash: claimTokenHash,
        workerClaimedAt: now,
        workerLeaseExpiresAt: now + leaseMs,
      };
      tasks.set(id, updated as Task);
      workerClaimedTaskIds.add(id);
      return updated as Task;
    },
    async renewWorkerLease(): Promise<boolean> { return true; },
    async isWorkerClaimValid(): Promise<boolean> { return true; },
    async completeWorkerTask(): Promise<Task | undefined> { return undefined; },
    async getExpiredWorkerTasks(): Promise<Task[]> { return []; },
    async getAssignedWorkerTasks(): Promise<Task[]> { return []; },
  };
  return { repo, getTasks: () => [...tasks.values()], calls };
}

function createWorkerRepo(): WorkerRepository {
  return {
    async register(): Promise<Worker> { return worker; },
    async heartbeat(): Promise<Worker> { return worker; },
    async getById(): Promise<Worker | undefined> { return worker; },
    async getByTokenHash(hash: string): Promise<(Worker & { readonly tokenHash: string }) | undefined> {
      const expected = crypto.createHash('sha256').update('worker-token').digest('hex');
      return hash === expected ? { ...worker, tokenHash: hash } : undefined;
    },
    async list(): Promise<Worker[]> { return [worker]; },
    async markOffline(): Promise<Worker[]> { return []; },
    async registerTaskSession(): Promise<void> {},
    async getTaskSessions(): Promise<readonly { sessionId: string; baseUrl: string; updatedAt: number }[]> { return []; },
    async enqueueTaskCommand(): Promise<void> {},
    async claimTaskCommands(): Promise<readonly { id: string; type: 'message' | 'clarification' | 'cancel'; createdAt: number; message?: string; attachmentIds?: readonly string[]; requestId?: string; sessionId?: string; answer?: string }[]> { return []; },
    async clearTaskCommands(): Promise<void> {},
  };
}

function createProjectRepo(project: Project): ProjectRepository {
  return {
    async getAllWithCounts(): Promise<Project[]> { return [project]; },
    async getById(id: string): Promise<Project | undefined> { return id === project.id ? project : undefined; },
    async getDefault(): Promise<Project> { return project; },
    async resolve(): Promise<Project[]> { return [project]; },
    async create(): Promise<Project> { return project; },
    async update(): Promise<Project> { return project; },
    async delete(): Promise<boolean> { return false; },
    async hasTasksOrGroups(): Promise<boolean> { return false; },
  };
}

function createManager(calls: { startAgent: number }, running = false): AgentManager {
  return {
    isRunning: () => running,
    stopAgent: async () => false,
    startAgent: () => { calls.startAgent += 1; },
    resetEvents: () => {},
    getAvailableAgents: () => [],
  } as unknown as AgentManager;
}

async function withApp(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('bind failed');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function jsonApp(): express.Express {
  const app = express();
  app.use(express.json());
  return app;
}

test('POST /api/tasks rejects path fields and does not inherit the project repo path', async () => {
  const { repo, getTasks, calls } = createTaskRepo();
  const app = jsonApp();
  app.use('/api/tasks', createTaskRouter(repo, createManager(calls), createProjectRepo(makeProject())));

  await withApp(app, async (baseUrl) => {
    for (const field of ['repoPath', 'worktreePath']) {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Task', [field]: '/private/path', projectId: 'project-1' }),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error, `${field} is not supported for tasks`);
    }

    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Portable task', projectId: 'project-1' }),
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal('repoPath' in body, false);
    assert.equal('worktreePath' in body, false);
    assert.equal(getTasks()[0]?.repoPath, undefined);
  });
});

test('task boundary normalizes portable labels and preserves agent preference', async () => {
  const { repo, getTasks, calls } = createTaskRepo();
  const app = jsonApp();
  app.use('/api/tasks', createTaskRouter(repo, createManager(calls), createProjectRepo(makeProject())));

  await withApp(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Portable task',
        projectId: 'project-1',
        labels: [' Feature ', 'FEATURE', 'Bug'],
        agentPreference: 'fast-coder',
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.deepEqual(body.labels, ['feature', 'bug']);
    assert.equal(body.agentPreference, 'fast-coder');
    assert.deepEqual(getTasks()[0]?.labels, ['feature', 'bug']);
    assert.equal(getTasks()[0]?.agentPreference, 'fast-coder');
  });
});

test('task boundary rejects local worker configuration fields', async () => {
  const { repo, calls } = createTaskRepo();
  const app = jsonApp();
  app.use('/api/tasks', createTaskRouter(repo, createManager(calls), createProjectRepo(makeProject())));

  await withApp(app, async (baseUrl) => {
    for (const field of ['workspacePath', 'projectPath', 'command', 'executable', 'skill']) {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Task', projectId: 'project-1', [field]: 'local-only' }),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error, `${field} is not supported for tasks`);
    }
  });
});

test('normalizeTaskLabels lowercases, deduplicates, trims, and bounds labels', () => {
  assert.deepEqual(normalizeTaskLabels([' Feature ', 'FEATURE', '', 'Bug']), ['feature', 'bug']);
  assert.deepEqual(normalizeTaskLabels('feature'), []);
  assert.deepEqual(normalizeTaskLabels(['a'.repeat(51)]), []);
});

test('PATCH /api/tasks/:id rejects repoPath and worktreePath and returns a portable task', async () => {
  const { repo, calls } = createTaskRepo([makeTask({ repoPath: '/private/internal', worktreePath: '/private/worktree' })]);
  const app = jsonApp();
  app.use('/api/tasks', createTaskRouter(repo, createManager(calls), createProjectRepo(makeProject())));

  await withApp(app, async (baseUrl) => {
    for (const field of ['repoPath', 'worktreePath']) {
      const response = await fetch(`${baseUrl}/api/tasks/task-1`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: '/private/path' }),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error, `${field} is not supported for tasks`);
    }

    const response = await fetch(`${baseUrl}/api/tasks/task-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branchName: 'feature/portable' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.branchName, 'feature/portable');
    assert.equal('repoPath' in body, false);
    assert.equal('worktreePath' in body, false);
  });
});

test('POST /api/tasks/:id/configure rejects repoPath and worktreePath', async () => {
  const { repo, calls } = createTaskRepo([makeTask()]);
  const app = jsonApp();
  app.use('/api/tasks', createAgentRouter(repo, createManager(calls), undefined, createProjectRepo(makeProject())));

  await withApp(app, async (baseUrl) => {
    for (const field of ['repoPath', 'worktreePath']) {
      const response = await fetch(`${baseUrl}/api/tasks/task-1/configure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: '/private/path', branchName: 'main', baseBranch: 'main', useWorktree: false }),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error, `${field} is not supported for tasks`);
    }
  });
});

test('POST /api/tasks/:id/run requires a worker and never starts AgentManager directly', async () => {
  const { repo, calls } = createTaskRepo([makeTask()]);
  const app = jsonApp();
  app.use('/api/tasks', createAgentRouter(repo, createManager(calls), undefined, createProjectRepo(makeProject())));

  await withApp(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/run`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.error, 'worker assignment is required');
    assert.equal(calls.requestRun, 0);
    assert.equal(calls.claimRun, 0);
    assert.equal(calls.startAgent, 0);
  });
});

test('POST /api/tasks/:id/run preserves durable worker run request and returns a portable task', async () => {
  const { repo, calls } = createTaskRepo([makeTask({ id: 'task-2', assignedWorkerId: 'worker-1' })]);
  const app = jsonApp();
  app.use('/api/tasks', createAgentRouter(repo, createManager(calls), undefined, createProjectRepo(makeProject())));
  app.use('/api/workers', createWorkersRouter(repo, createWorkerRepo()));

  await withApp(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-2/run`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls.requestRun, 1);
    assert.equal(calls.claimRun, 0);
    assert.equal(calls.startAgent, 0);
    assert.equal('repoPath' in body, false);
    assert.equal('worktreePath' in body, false);

    const claimResponse = await fetch(`${baseUrl}/api/workers/me/tasks/task-2/claim`, {
      method: 'POST',
      headers: { authorization: 'Bearer worker-token' },
    });
    const claimBody = await claimResponse.json();
    assert.equal(claimResponse.status, 200);
    assert.equal(claimBody.task.id, 'task-2');
  });
});

test('buildTask and broadcastTaskUpdate keep repoPath and worktreePath out of portable task payloads', async () => {
  const built = buildTask({
    title: 'Portable task',
    description: 'desc',
    priority: 'high',
    columnId: 'review',
    agentType: 'codex',
    projectId: 'project-1',
    repoPath: '/private/repo',
    worktreePath: '/private/worktree',
    branchName: 'feature/portable',
    baseBranch: 'main',
    useWorktree: true,
    timeoutMinutes: 45,
  });

  assert.equal('repoPath' in built, false);
  assert.equal('worktreePath' in built, false);
  assert.equal(built.branchName, 'feature/portable');
  assert.equal(built.baseBranch, 'main');
  assert.equal(built.useWorktree, true);
  assert.equal(built.timeoutMinutes, 45);

  const server = createServer();
  const wss = createWSS(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('bind failed');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);

    const message = await new Promise<string>((resolve, reject) => {
      socket.once('open', () => {
        broadcastTaskUpdate({
          ...makeTask({ repoPath: '/private/repo', worktreePath: '/private/worktree' }),
          title: 'Broadcast task',
        });
      });
      socket.once('message', (data) => {
        socket.close();
        resolve(data.toString());
      });
      socket.once('error', reject);
    });

    const parsed = JSON.parse(message) as { type: string; payload: Task };
    assert.equal(parsed.type, 'task_updated');
    assert.equal('repoPath' in parsed.payload, false);
    assert.equal('worktreePath' in parsed.payload, false);
    assert.equal(parsed.payload.title, 'Broadcast task');
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
