import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import express from 'express';
import { TaskState } from '@a2a-js/sdk';
import { BoardEventHub } from '../src/a2a/event-hub.js';
import { createA2ARouter } from '../src/a2a/router.js';
import type { AgentEvent, Project, Task } from '../src/types.js';

/**
 * #78: a streaming peer must receive run progress, not just the admitted task.
 *
 * These tests drive the real SDK handlers over HTTP and read the SSE body, so
 * they fail if the executor closes the bus early (the previous behaviour) or
 * if the relay never ends the stream.
 */

type Json = Record<string, any>;

function project(): Project {
  return {
    id: 'project-1',
    name: 'board',
    repoPath: '/srv/board',
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Project;
}

function createFakes() {
  const tasks = new Map<string, Task>();
  const taskRepo = {
    getById: async (id: string) => tasks.get(id),
    getAll: async () => [...tasks.values()],
    create: async (task: Task) => { tasks.set(task.id, task); return task; },
    createIdempotent: async (task: Task) => {
      const existing = [...tasks.values()].find((candidate) => candidate.idempotencyKey === task.idempotencyKey);
      if (existing) return { task: existing, created: false };
      tasks.set(task.id, task);
      return { task, created: true };
    },
    update: async (id: string, updates: Partial<Task>) => {
      const current = tasks.get(id);
      if (!current) return undefined;
      const next = { ...current, ...updates };
      tasks.set(id, next);
      return next;
    },
  } as unknown as Parameters<typeof createA2ARouter>[0]['taskRepo'];

  const projectRepo = {
    resolve: async (reference: string) => (reference === 'board' ? [project()] : []),
    getById: async (id: string) => (id === 'project-1' ? project() : undefined),
    getAllWithCounts: async () => [project()],
  } as unknown as Parameters<typeof createA2ARouter>[0]['projectRepo'];

  const agents = {
    getAvailableAgents: () => [{ type: 'opencode', available: true }],
    isRunning: () => false,
    stopAgent: async () => true,
    sendMessage: async () => true,
  } as unknown as Parameters<typeof createA2ARouter>[0]['agents'];

  return { tasks, taskRepo, projectRepo, agents };
}

async function withBoard(
  hub: BoardEventHub,
  run: (baseUrl: string, fakes: ReturnType<typeof createFakes>) => Promise<void>,
): Promise<void> {
  const fakes = createFakes();
  const app = express();
  app.use(express.json());
  app.use('/', createA2ARouter({
    taskRepo: fakes.taskRepo,
    projectRepo: fakes.projectRepo,
    agents: fakes.agents,
    boardVersion: '0.0.0-test',
    publicUrl: 'http://127.0.0.1:0',
    events: hub,
  }));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`, fakes);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function sendStreamingBody(messageId: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: messageId,
    method: 'SendStreamingMessage',
    params: {
      message: {
        messageId,
        role: 'ROLE_USER',
        parts: [{ text: 'Add rate limiting\n\nThe worker event endpoint is unbounded.' }],
        metadata: { project: 'board', autoStart: false },
      },
    },
  });
}

/** Reads SSE `data:` payloads until `predicate` is satisfied or the stream ends. */
async function readStream(
  response: Response,
  predicate: (events: Json[]) => boolean,
  onFirst?: () => void | Promise<void>,
): Promise<Json[]> {
  assert.ok(response.body, 'expected an SSE body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const collected: Json[] = [];
  let buffer = '';
  let announced = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        collected.push(JSON.parse(line.slice(5).trim()) as Json);
      }
      separator = buffer.indexOf('\n\n');
    }

    if (!announced && collected.length > 0 && onFirst) {
      announced = true;
      await onFirst();
    }
    if (predicate(collected)) break;
  }
  await reader.cancel().catch(() => {});
  return collected;
}

/**
 * Unwraps the JSON-RPC envelope and the `StreamResponse` oneof, so a caller
 * sees the task / statusUpdate / artifactUpdate payload itself.
 */
function resultsOf(events: Json[]): Json[] {
  return events.map((event) => {
    const result = (event.result ?? event) as Json;
    return (result.task ?? result.statusUpdate ?? result.artifactUpdate ?? result) as Json;
  });
}

test('a streaming send carries board progress and ends on the terminal state', async () => {
  const hub = new BoardEventHub();
  await withBoard(hub, async (baseUrl, fakes) => {
    const response = await fetch(`${baseUrl}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', accept: 'text/event-stream' },
      body: sendStreamingBody('stream-1'),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const events = await readStream(
      response,
      (collected) => resultsOf(collected).some((result) => result.status?.state === 'TASK_STATE_COMPLETED'
        || result.status?.state === TaskState.TASK_STATE_COMPLETED),
      async () => {
        // The board is now running the work. Progress arrives the way it does
        // in production: board events broadcast while the run proceeds.
        const [task] = [...fakes.tasks.values()];
        assert.ok(task, 'the admitted task should exist before progress is reported');
        const event = (type: AgentEvent['type'], content: string): AgentEvent => ({
          id: `${type}-${content.length}`,
          taskId: task.id,
          type,
          content,
          timestamp: Date.now(),
        } as AgentEvent);

        hub.publish({ kind: 'event', event: event('thinking', 'Reading the ingress route') });
        hub.publish({ kind: 'event', event: event('file_edit', 'Patched packages/server/src/routes/workers.ts') });
        await fakes.taskRepo.update(task.id, { agentStatus: 'complete', columnId: 'review', completedAt: Date.now() });
        const updated = await fakes.taskRepo.getById(task.id);
        assert.ok(updated);
        hub.publish({ kind: 'task', task: updated });
      },
    );

    const results = resultsOf(events);
    // The stream opens with the admitted task...
    assert.ok(results[0]?.id, 'first stream event should be the task');
    // ...carries the board's progress text...
    const texts = results.flatMap((result) => (result.status?.message?.parts ?? []).map((part: Json) => part.text));
    assert.ok(texts.some((text?: string) => text?.includes('Reading the ingress route')), 'progress text missing');
    assert.ok(
      texts.some((text?: string) => text?.includes('Patched packages/server/src/routes/workers.ts')),
      'milestone text missing',
    );
    // ...and ends on the terminal status rather than hanging. (The SDK closes
    // the stream on a terminal status update, so that frame is the last one.)
    const last = results[results.length - 1];
    assert.ok(
      last?.status?.state === 'TASK_STATE_COMPLETED' || last?.status?.state === TaskState.TASK_STATE_COMPLETED,
      `expected a completed final state, got ${JSON.stringify(last?.status?.state)}`,
    );
  });
});

test('the relay unsubscribes once the stream has ended', async () => {
  const hub = new BoardEventHub();
  await withBoard(hub, async (baseUrl, fakes) => {
    const response = await fetch(`${baseUrl}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', accept: 'text/event-stream' },
      body: sendStreamingBody('stream-2'),
    });

    await readStream(
      response,
      (collected) => resultsOf(collected).some((result) => result.final === true),
      async () => {
        const [task] = [...fakes.tasks.values()];
        assert.ok(task);
        await fakes.taskRepo.update(task.id, { agentStatus: 'failed', columnId: 'in-progress' });
        const updated = await fakes.taskRepo.getById(task.id);
        assert.ok(updated);
        hub.publish({ kind: 'task', task: updated });
      },
    );

    // A terminal run must not leave a subscription behind: that is the leak
    // that would accumulate one entry per streamed task for the process's life.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(hub.subscribedTaskCount, 0);
  });
});

test('a non-streaming send still answers immediately with the admitted task', async () => {
  // The relay keeps the bus open; that must not make `SendMessage` block
  // until the run finishes.
  const hub = new BoardEventHub();
  await withBoard(hub, async (baseUrl) => {
    const started = Date.now();
    const response = await fetch(`${baseUrl}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'plain-1',
        method: 'SendMessage',
        params: {
          message: {
            messageId: 'plain-1',
            role: 'ROLE_USER',
            parts: [{ text: 'Plain send' }],
            metadata: { project: 'board', autoStart: false },
          },
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as Json;
    const task = (body.result as Json).task as Json;
    assert.ok(task.id);
    assert.ok(Date.now() - started < 5_000, 'SendMessage should not wait for the run');
  });
});
