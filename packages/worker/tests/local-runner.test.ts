import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk';
import {
  parseWorkspaceSettings,
  startOpenCodeServerTask,
  type CreateOpenCodeClient,
  type OpenCodeClientLike,
  type OpenCodeProcess,
  type OpenCodeSpawn,
} from '../src/local-runner.js';

const task: WorkerTaskAssignment = {
  id: 'task-1',
  title: 'Implement local runner seam',
  description: 'Wire worker to opencode run with a local profile',
  priority: 'high',
  labels: ['orioninit', 'worker-local'],
  agentType: 'opencode',
};

class FakeOpenCodeProcess extends EventEmitter implements OpenCodeProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killCalled = false;

  kill(): boolean {
    this.killCalled = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', null, 'SIGTERM');
    return true;
  }
}

test('parseWorkspaceSettings defaults to agent-sdk for legacy workspace-only config', () => {
  const parsed = parseWorkspaceSettings({ workspacePath: '/tmp/workspace' });
  assert.deepEqual(parsed, {
    workspacePath: '/tmp/workspace',
    runner: { kind: 'agent-sdk' },
  });
});

test('parseWorkspaceSettings rejects opencode-server runner without agent', () => {
  assert.throws(
    () => parseWorkspaceSettings({ workspacePath: '/tmp/workspace', runner: { kind: 'opencode-server' } }),
    /runner.agent must be a non-empty string when runner.kind is opencode-server/,
  );
});

type FakeClientState = {
  readonly sessionCreates: string[];
  readonly prompts: Array<{ sessionId: string; agent?: string; text: string }>;
  readonly aborts: string[];
};

function emptyAsyncGenerator<T>(): AsyncGenerator<T, void, unknown> {
  return (async function* stream(): AsyncGenerator<T, void, unknown> {
    return;
  })();
}

function createFakeClient(
  state: FakeClientState,
  stream: AsyncGenerator<OpenCodeEvent, void, unknown> = emptyAsyncGenerator<OpenCodeEvent>(),
): OpenCodeClientLike {
  return {
    session: {
      create: async ({ body }) => {
        state.sessionCreates.push(body?.title ?? '');
        return { data: { id: 'ses_worker_1' } };
      },
      prompt: async ({ path, body }) => {
        const first = body?.parts[0];
        const text = first?.type === 'text' ? first.text : '';
        state.prompts.push({ sessionId: path.id, agent: body?.agent, text });
        return { data: { info: {} } };
      },
      abort: async ({ path }) => {
        state.aborts.push(path.id);
        return { data: true };
      },
    },
    event: {
      subscribe: async () => ({ stream }),
    },
  };
}

test('startOpenCodeServerTask starts a task-titled session and prompts with the configured agent', async () => {
  const spawned = new FakeOpenCodeProcess();
  const state: FakeClientState = { sessionCreates: [], prompts: [], aborts: [] };

  const spawnFn: OpenCodeSpawn = (nextCommand, nextArgs, options) => {
    assert.equal(nextCommand, 'opencode');
    assert.deepEqual(nextArgs, ['serve', '--hostname=127.0.0.1', '--port=0']);
    assert.equal(options.shell, false);
    queueMicrotask(() => {
      spawned.stdout.write('opencode server listening on http://127.0.0.1:4096\n');
      spawned.stdout.end();
      spawned.stderr.end();
    });
    return spawned;
  };

  const clientFactory: CreateOpenCodeClient = (config) => {
    assert.equal(config.baseUrl, 'http://127.0.0.1:4096');
    assert.equal(config.directory, '/tmp/workspace');
    return createFakeClient(state);
  };

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    sendEvent: async () => {},
    spawnFn,
    createClient: clientFactory,
  });
  const result = await live.done;

  assert.equal(live.baseUrl, 'http://127.0.0.1:4096');
  assert.equal(live.sessionId, 'ses_worker_1');
  assert.deepEqual(state.sessionCreates, ['Implement local runner seam']);
  assert.equal(state.prompts.length, 1);
  assert.deepEqual(state.prompts[0], {
    sessionId: 'ses_worker_1',
    agent: 'sisyphus',
    text: [
      'Task title: Implement local runner seam',
      '',
      'Task description: Wire worker to opencode run with a local profile',
      '',
      'Labels: orioninit, worker-local',
    ].join('\n'),
  });
  assert.equal(result.status, 'complete');
});

test('startOpenCodeServerTask streams mapped SSE events and strips local workspace paths', async () => {
  const state: FakeClientState = { sessionCreates: [], prompts: [], aborts: [] };
  const sse = (async function* stream(): AsyncGenerator<OpenCodeEvent, void, unknown> {
    yield {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'text',
          sessionID: 'ses_worker_1',
          messageID: 'msg-1',
          text: 'Path /tmp/workspace/README.md',
        },
        delta: 'Path /tmp/workspace/README.md',
      },
    } as unknown as OpenCodeEvent;
  })();
  const events: string[] = [];

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async (event) => {
      events.push(event.content);
    },
    createClient: () => createFakeClient(state, sse),
  });
  await live.done;

  assert.equal(events.some((value) => value.includes('[local workspace]')), true);
});

test('startOpenCodeServerTask forwards follow-up messages and abort to the same session', async () => {
  const state: FakeClientState = { sessionCreates: [], prompts: [], aborts: [] };
  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createClient: () => createFakeClient(state),
  });

  await live.sendMessage('Need clarification details');
  await live.abort();
  await live.done;

  assert.equal(state.prompts.length, 2);
  assert.deepEqual(state.prompts[1], {
    sessionId: 'ses_worker_1',
    agent: 'sisyphus',
    text: 'Need clarification details',
  });
  assert.deepEqual(state.aborts, ['ses_worker_1']);
});
