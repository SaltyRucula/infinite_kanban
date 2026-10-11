import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { BoardWorkflowCoordinator } from '../src/services/board-workflow.js';
import { SqliteWorkflowStore } from '../src/repositories/workflow-store.js';
import { createA2ARouter } from '../src/a2a/router.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import { createWorkflowOwnershipGuard } from '../src/routes/workflow-ownership.js';
import type { TaskGroupRepository } from '../src/repositories/group-types.js';
import type { Task } from '../src/types.js';

test('legacy task, git, group and project mutations refuse owned tasks before side effects', async () => {
  const app = express();
  const task = { id: 'owned' } as Task;
  app.use('/api', createWorkflowOwnershipGuard({ ownsTask: async (id) => id === 'owned' }, {
    tasks: { getAll: async (_archived = false, projectId = 'default') => projectId === 'p' ? [task] : [] },
    groups: { getChildTasks: async (id) => id === 'g' ? [task] : [] },
  }));
  app.use((_req, res) => res.json({ legacy: true }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    for (const [method, path] of [['PATCH', '/tasks/owned'], ['POST', '/tasks/owned/assign'], ['POST', '/tasks/owned/merge-local'], ['POST', '/groups/g/run'], ['DELETE', '/groups/g'], ['DELETE', '/projects/p']]) {
      assert.equal((await fetch(base + path, { method })).status, 409, `${method} ${path}`);
    }
    // Batch/create assign generated IDs, never an existing workflow-owned ID.
    for (const [method, path] of [['GET', '/tasks/owned'], ['POST', '/tasks/batch'], ['POST', '/tasks'], ['POST', '/groups'], ['DELETE', '/projects/other']]) {
      assert.equal((await fetch(base + path, { method })).status, 200, `${method} ${path}`);
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('scoped A2A cancellation cannot mutate a workflow-owned task or fence only the legacy card', async () => {
  const oldKey = process.env.API_KEY;
  const oldTokens = process.env.SERVICE_TOKENS;
  process.env.API_KEY = 'ownership-test-admin';
  process.env.SERVICE_TOKENS = JSON.stringify([{ token: 'ownership-test-peer', id: 'endpoint', scopes: ['a2a:send'] }]);
  const db = new Database(':memory:');
  const store = new SqliteWorkflowStore(db);
  let task: Task = {
    id: 't', projectId: 'p', title: 'Do it', description: 'Requirements',
    columnId: 'backlog', agentStatus: 'idle', agentType: 'opencode',
    priority: 'medium', labels: [], createdAt: 1,
  };
  let stopped = false;
  const tasks = {
    getById: async () => task,
    update: async (_id: string, changes: Partial<Task>) => { task = { ...task, ...changes }; return task; },
  };
  const coordinator = new BoardWorkflowCoordinator(store, tasks, { getAll: async () => [{
    id: 'implementer', name: 'Implementer', description: '', version: 'test', agentCardUrl: 'http://localhost:4100/.well-known/agent-card.json', enabled: true, endpoint: 'http://localhost:4100/a2a/v1', protocolVersion: '1.0', createdAt: 1, updatedAt: 1, lastValidatedAt: 1,
    projectAccess: [{ agentId: 'implementer', projectId: 'p', roles: ['implementation'], createdAt: 1, updatedAt: 1 }],
    skills: [{ id: 'execution', name: 'Execution', tags: ['execution:v1', 'repository:github.com/o/r', 'consent:p'] }],
  }] }, () => ({ dispatch: async () => ({ remoteTaskId: 'remote' }), getUpdate: async () => ({ state: 'running', artifacts: [] }), cancel: async () => {} }), async () => {});
  await coordinator.start('t', { repository: 'https://github.com/o/r', baseRevision: 'a'.repeat(40) });
  const app = express();
  app.use(express.json());
  app.use(createA2ARouter({
    taskRepo: tasks as TaskRepository,
    projectRepo: { getAllWithCounts: async () => [{ id: 'p' }] } as unknown as ProjectRepository,
    agents: { stopAgent: async () => { stopped = true; }, sendMessage: async () => { stopped = true; return true; }, isRunning: () => false } as unknown as AgentManager,
    boardVersion: 'test', publicUrl: 'https://board.example',
    // Run the guard against the durable coordinator, not a canned boolean.
    ownsTask: (id: string) => coordinator.ownsTask(id),
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a/v1`, {
      method: 'POST',
      headers: { authorization: 'Bearer ownership-test-peer', 'content-type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'cancel', method: 'CancelTask', params: { id: 't' } }),
    });
    const payload = await response.json();
    assert.ok(payload.error, JSON.stringify(payload));
    assert.match(payload.error.message, /workflow/);
    assert.equal(stopped, false);
    assert.equal(task.agentStatus, 'executing');
    assert.equal(task.completedAt, undefined);
    assert.equal((await coordinator.get('t'))?.phase, 'implementing');
    assert.equal((await coordinator.get('t'))?.assignments[0].state, 'running');
    const followUp = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a/v1`, {
      method: 'POST',
      headers: { authorization: 'Bearer ownership-test-peer', 'content-type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'follow-up', method: 'SendMessage', params: { message: { messageId: 'follow-up', taskId: 't', role: 'ROLE_USER', parts: [{ text: 'Bypass coordinator' }] }, configuration: { returnImmediately: false } } }),
    });
    const followUpPayload = await followUp.json();
    assert.ok(followUpPayload.error, JSON.stringify(followUpPayload));
    assert.match(followUpPayload.error.message, /workflow/);
    assert.equal(stopped, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    if (oldKey === undefined) delete process.env.API_KEY; else process.env.API_KEY = oldKey;
    if (oldTokens === undefined) delete process.env.SERVICE_TOKENS; else process.env.SERVICE_TOKENS = oldTokens;
  }
});
