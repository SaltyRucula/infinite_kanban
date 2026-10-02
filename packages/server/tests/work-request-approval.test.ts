import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createTaskRouter } from '../src/routes/tasks.js';
import type { AgentEvent, Task } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';

const origin: Task = {
  id: 'origin-task',
  title: 'Origin task',
  description: 'A running worker requested follow-up work.',
  priority: 'high',
  columnId: 'in-progress',
  agentStatus: 'executing',
  createdAt: 1,
  projectId: 'default',
  labels: [],
};

const workRequest: AgentEvent = {
  id: 'event-work-request',
  taskId: origin.id,
  type: 'request_work',
  content: 'Requesting a database review',
  timestamp: 2,
  metadata: {
    workRequest: {
      title: 'Review the database migration',
      description: 'Validate rollout safety before deployment.',
      agentType: 'codex',
    },
  },
};

test('approving a worker work request creates one backlog task without auto-running it', async () => {
  const created: Task[] = [];
  const repo = {
    getById: async (id: string) => id === origin.id ? origin : undefined,
    getEventsByTaskId: async (taskId: string) => taskId === origin.id ? [workRequest] : [],
    createIdempotent: async (task: Task) => {
      created.push(task);
      return { task, created: true };
    },
  } as unknown as TaskRepository;
  const projects = {
    getById: async (id: string) => id === 'default'
      ? { id: 'default', name: 'Default', isDefault: true }
      : undefined,
    getDefault: async () => ({ id: 'default', name: 'Default', isDefault: true }),
  };
  const manager = { isRunning: () => false, stopAgent: () => {}, clearEvents: () => {} };

  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createTaskRouter(repo, manager as any, projects as any));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${origin.id}/work-requests/${workRequest.id}/approve`, {
      method: 'POST',
    });

    assert.equal(response.status, 201);
    assert.equal(created.length, 1);
    assert.deepEqual(
      {
        title: created[0]?.title,
        description: created[0]?.description,
        agentType: created[0]?.agentType,
        columnId: created[0]?.columnId,
        projectId: created[0]?.projectId,
        agentStatus: created[0]?.agentStatus,
      },
      {
        title: 'Review the database migration',
        description: 'Validate rollout safety before deployment.',
        agentType: 'codex',
        columnId: 'backlog',
        projectId: 'default',
        agentStatus: 'idle',
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('dismissing a worker work request persists the decision without creating or running work', async () => {
  const inserted: AgentEvent[] = [];
  let createCalls = 0;
  const repo = {
    getById: async (id: string) => id === origin.id ? origin : undefined,
    getEventsByTaskId: async (taskId: string) => taskId === origin.id ? [workRequest] : [],
    insertEvent: async (event: AgentEvent) => { inserted.push(event); },
    createIdempotent: async () => {
      createCalls += 1;
      throw new Error('dismissing must not create work');
    },
  } as unknown as TaskRepository;
  const projects = {
    getById: async () => ({ id: 'default', name: 'Default', isDefault: true }),
    getDefault: async () => ({ id: 'default', name: 'Default', isDefault: true }),
  };
  const manager = { isRunning: () => false, stopAgent: () => {}, clearEvents: () => {} };

  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createTaskRouter(repo, manager as any, projects as any));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${origin.id}/work-requests/${workRequest.id}/dismiss`, {
      method: 'POST',
    });

    assert.equal(response.status, 204);
    assert.equal(createCalls, 0);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]?.taskId, origin.id);
    assert.equal(inserted[0]?.metadata?.dismissedWorkRequestEventId, workRequest.id);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
