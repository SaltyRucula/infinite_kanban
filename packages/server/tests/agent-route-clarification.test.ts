import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import express from 'express';
import { createAgentRouter } from '../src/routes/agent.js';
import type { Task } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { AgentManager } from '../src/services/agent-manager.js';

type ResumeResult = {
  readonly ok: boolean;
  readonly code:
    | 'resumed'
    | 'invalid_request'
    | 'no_pending_clarification'
    | 'session_not_running'
    | 'stale_session'
    | 'stale_request'
    | 'duplicate_answer'
    | 'send_failed';
  readonly message: string;
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'default',
    title: 'Task',
    description: 'desc',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'awaiting_clarification',
    agentType: 'opencode',
    createdAt: 1,
    ...overrides,
  };
}

function createRepo(tasks: readonly Task[]): TaskRepository {
  const map = new Map(tasks.map((task) => [task.id, task]));
  return {
    async getAll(): Promise<Task[]> {
      return [...map.values()];
    },
    async getById(id: string): Promise<Task | undefined> {
      return map.get(id);
    },
    async getByExternalIdentity(_projectId: string, _source: string, _key: string): Promise<Task | undefined> {
      return undefined;
    },
    async create(task: Task): Promise<Task> {
      map.set(task.id, task);
      return task;
    },
    async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
      const existing = map.get(task.id);
      if (existing) return { task: existing, created: false };
      map.set(task.id, task);
      return { task, created: true };
    },
    async requestRun(): Promise<Task | undefined> {
      return undefined;
    },
    async claimRun(): Promise<Task | undefined> {
      return undefined;
    },
    async clearRun(): Promise<Task | undefined> {
      return undefined;
    },
    async getPendingRuns(): Promise<Task[]> {
      return [];
    },
    async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
      const existing = map.get(id);
      if (!existing) return undefined;
      const merged = { ...existing, ...updates };
      map.set(id, merged);
      return merged;
    },
    async delete(id: string): Promise<boolean> {
      return map.delete(id);
    },
    async count(): Promise<number> {
      return map.size;
    },
    async insertEvent(): Promise<void> {},
    async getEventsByTaskId(): Promise<[]> {
      return [];
    },
    async deleteEventsByTaskId(): Promise<void> {},
    async getArchivedTasks(): Promise<Task[]> {
      return [];
    },
  };
}

function createManager(overrides: {
  readonly isRunning?: boolean;
  readonly resume?: ResumeResult;
  readonly onResume?: (taskId: string, payload: { requestId: string; sessionId: string; answer: string }) => void;
} = {}): AgentManager {
  return {
    isRunning: () => overrides.isRunning ?? true,
    stopAgent: async () => false,
    startAgent: () => {},
    resetEvents: () => {},
    sendMessage: async () => true,
    resumeClarification: async (taskId, payload) => {
      overrides.onResume?.(taskId, payload);
      return overrides.resume ?? {
        ok: true,
        code: 'resumed',
        message: 'clarification accepted and session resumed',
      };
    },
  } as unknown as AgentManager;
}

async function withAgentApp(
  repo: TaskRepository,
  agentManager: AgentManager,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createAgentRouter(repo, agentManager));

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('failed to bind test server');
    }
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test('agent message route rejects follow-up messages while task is awaiting clarification', async () => {
  const repo = createRepo([makeTask()]);
  const manager = createManager({ isRunning: true });

  await withAgentApp(repo, manager, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'continue with main' }),
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.match(String(body.error), /awaiting clarification/i);
  });
});

test('agent clarification resume route forwards request payload and returns success body', async () => {
  const repo = createRepo([makeTask()]);
  let capturedTaskId = '';
  let capturedPayload: { requestId: string; sessionId: string; answer: string } | null = null;
  const manager = createManager({
    onResume: (taskId, payload) => {
      capturedTaskId = taskId;
      capturedPayload = payload;
    },
  });

  await withAgentApp(repo, manager, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/clarification/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'req-1', sessionId: 'session-1', answer: 'main' }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(capturedTaskId, 'task-1');
    assert.deepEqual(capturedPayload, { requestId: 'req-1', sessionId: 'session-1', answer: 'main' });
    assert.deepEqual(body, {
      success: true,
      code: 'resumed',
      message: 'clarification accepted and session resumed',
    });
  });
});

test('agent clarification resume route rejects non-awaiting statuses before delegating to manager', async () => {
  const disallowedStatuses: Task['agentStatus'][] = ['executing', 'complete', 'failed'];

  for (const status of disallowedStatuses) {
    const repo = createRepo([makeTask({ agentStatus: status })]);
    let resumeCalls = 0;
    const manager = createManager({
      onResume: () => {
        resumeCalls += 1;
      },
    });

    await withAgentApp(repo, manager, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/task-1/clarification/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'req-1', sessionId: 'session-1', answer: 'main' }),
      });
      const body = await response.json();

      assert.equal(response.status, 409);
      assert.match(String(body.error), /awaiting_clarification/i);
      assert.equal(body.code, 'clarification_not_pending');
      assert.equal(resumeCalls, 0);
    });
  }
});

test('agent clarification resume route maps invalid_request to 400', async () => {
  const repo = createRepo([makeTask()]);
  const manager = createManager({
    resume: {
      ok: false,
      code: 'invalid_request',
      message: 'requestId, sessionId, and answer are required',
    },
  });

  await withAgentApp(repo, manager, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/clarification/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: '', sessionId: '', answer: '' }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: 'requestId, sessionId, and answer are required',
      code: 'invalid_request',
    });
  });
});

test('agent clarification resume route maps stale_session to 409', async () => {
  const repo = createRepo([makeTask()]);
  const manager = createManager({
    resume: {
      ok: false,
      code: 'stale_session',
      message: 'clarification response sessionId does not match the live session identity',
    },
  });

  await withAgentApp(repo, manager, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/clarification/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'req-1', sessionId: 'stale', answer: 'main' }),
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.deepEqual(body, {
      error: 'clarification response sessionId does not match the live session identity',
      code: 'stale_session',
    });
  });
});

test('agent clarification resume route returns 404 when task does not exist', async () => {
  const repo = createRepo([]);
  const manager = createManager();

  await withAgentApp(repo, manager, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/missing/clarification/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'req-1', sessionId: 'session-1', answer: 'main' }),
    });
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.deepEqual(body, { error: 'task not found' });
  });
});
