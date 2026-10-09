import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import test from 'node:test';
import type { WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import { createWorkerA2ARouter, startWorkerA2AServer } from '../src/a2a-server.js';

function assignmentMessage(assignment: Record<string, unknown>, messageId: string): Record<string, unknown> {
  return {
    messageId,
    role: 'ROLE_USER',
    parts: [{ data: assignment }],
    metadata: {
      'https://github.com/SaltyRucula/infinite_kanban/a2a/board/v1#assignment': assignment,
    },
  };
}

async function withWorker(
  run: (context: { readonly baseUrl: string; readonly received: WorkerTaskAssignment[] }) => Promise<void>,
): Promise<void> {
  const received: WorkerTaskAssignment[] = [];
  const app = express();
  app.use(express.json());
  app.use(createWorkerA2ARouter({
    baseUrl: 'https://worker.example.test',
    name: 'Build worker',
    version: '0.1.0',
    agentTypes: ['codex'],
    dispatch: async (assignment) => { received.push(assignment); },
  }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, received });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('worker A2A server publishes its card and dispatches an allowed SendMessage assignment', async () => {
  await withWorker(async ({ baseUrl, received }) => {
    const cardResponse = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    assert.equal(cardResponse.status, 200);
    const card = await cardResponse.json() as { name: string; supportedInterfaces: Array<{ url: string }> };
    assert.equal(card.name, 'Build worker');
    assert.equal(card.supportedInterfaces[0]?.url, 'https://worker.example.test/a2a/v1');

    const assignment: WorkerTaskAssignment = {
      id: 'task-1',
      title: 'Add A2A worker transport',
      description: 'Accept work from the board.',
      priority: 'high',
      agentType: 'codex',
      labels: ['a2a'],
    };
    const response = await fetch(`${baseUrl}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'send-1',
        method: 'SendMessage',
        params: { message: assignmentMessage(assignment as unknown as Record<string, unknown>, 'assignment-1') },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { result?: { task?: { status?: { state?: string } } }; error?: unknown };
    assert.equal(body.error, undefined);
    assert.equal(body.result?.task?.status?.state, 'TASK_STATE_COMPLETED');
    assert.deepEqual(received, [assignment]);
  });
});

test('worker A2A server refuses a board assignment carrying a local path', async () => {
  await withWorker(async ({ baseUrl, received }) => {
    const assignment = {
      id: 'task-1', title: 'Unsafe', description: 'No path leakage.', priority: 'high', labels: [], repoPath: '/private/repo',
    };
    const response = await fetch(`${baseUrl}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'send-unsafe',
        method: 'SendMessage',
        params: { message: assignmentMessage(assignment, 'assignment-unsafe') },
      }),
    });
    const body = await response.json() as { error?: { message?: string } };
    assert.match(body.error?.message ?? '', /unexpected assignment fields: repoPath/);
    assert.deepEqual(received, []);
  });
});

test('worker A2A listener binds the requested loopback address and serves its card', async () => {
  const listener = await startWorkerA2AServer({
    host: '127.0.0.1',
    port: 0,
    name: 'Loopback worker',
    version: '0.1.0',
    agentTypes: ['codex'],
    dispatch: async () => undefined,
  });
  try {
    assert.match(listener.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${listener.baseUrl}/.well-known/agent-card.json`);
    assert.equal(response.status, 200);
    const card = await response.json() as { supportedInterfaces: Array<{ url: string }> };
    assert.equal(card.supportedInterfaces[0]?.url, `${listener.baseUrl}/a2a/v1`);
  } finally {
    await listener.close();
  }
});
