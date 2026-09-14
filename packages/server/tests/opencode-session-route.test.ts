import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import express from 'express';
import { createAgentRouter } from '../src/routes/agent.js';
import type { Task } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { WorkerRepository } from '../src/repositories/worker-types.js';
import type { AgentManager } from '../src/services/agent-manager.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'default',
    title: 'Task',
    description: 'desc',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'executing',
    agentType: 'opencode',
    createdAt: 1,
    ...overrides,
  };
}

function createRepo(task: Task): TaskRepository {
  return {
    async getAll(): Promise<Task[]> { return [task]; },
    async getById(id: string): Promise<Task | undefined> { return id === task.id ? task : undefined; },
    async getByExternalIdentity(): Promise<Task | undefined> { return undefined; },
    async create(): Promise<Task> { throw new Error('not implemented'); },
    async createIdempotent(): Promise<{ task: Task; created: boolean }> { throw new Error('not implemented'); },
    async requestRun(): Promise<Task | undefined> { return undefined; },
    async claimRun(): Promise<Task | undefined> { return undefined; },
    async clearRun(): Promise<Task | undefined> { return undefined; },
    async getPendingRuns(): Promise<Task[]> { return []; },
    async update(): Promise<Task | undefined> { return undefined; },
    async delete(): Promise<boolean> { return false; },
    async count(): Promise<number> { return 1; },
    async insertEvent(): Promise<void> {},
    async getEventsByTaskId(): Promise<[]> { return []; },
    async deleteEventsByTaskId(): Promise<void> {},
    async getArchivedTasks(): Promise<Task[]> { return []; },
  };
}

function createWorkerRepo(baseUrl: string): WorkerRepository {
  return {
    async register(): Promise<never> { throw new Error('not implemented'); },
    async heartbeat(): Promise<never> { throw new Error('not implemented'); },
    async getById(): Promise<never> { throw new Error('not implemented'); },
    async getByTokenHash(): Promise<never> { throw new Error('not implemented'); },
    async list(): Promise<never> { throw new Error('not implemented'); },
    async markOffline(): Promise<never> { throw new Error('not implemented'); },
    async registerTaskSession(): Promise<void> {},
    async getTaskSessions(): Promise<readonly { sessionId: string; baseUrl: string; updatedAt: number }[]> {
      return [{ sessionId: 'ses_123', baseUrl, updatedAt: 1 }];
    },
    async enqueueTaskCommand(): Promise<void> {},
    async claimTaskCommands(): Promise<never> { throw new Error('not implemented'); },
    async clearTaskCommands(): Promise<void> {},
  };
}

function createManager(sessionId: string): AgentManager {
  return {
    isRunning: () => true,
    stopAgent: async () => false,
    startAgent: () => {},
    resetEvents: () => {},
    sendMessage: async () => true,
    resumeClarification: async () => ({ ok: false, code: 'invalid_request', message: 'not used' }),
    getSessionIdentity: () => sessionId,
  } as unknown as AgentManager;
}

async function withApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createAgentRouter(createRepo(makeTask()), createManager('ses_live'), undefined, undefined, createWorkerRepo('http://127.0.0.1:4096/')));

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind test server');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test('opencode session route returns the normalized base URL and session id', async () => {
  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/opencode-session`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      sessionId: 'ses_123',
      url: 'http://127.0.0.1:4096',
    });
  });
});
