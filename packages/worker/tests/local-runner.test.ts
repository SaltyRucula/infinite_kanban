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
  readonly existingSessions?: readonly string[];
  readonly replyText?: string;
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
      get: async ({ path }) => {
        if (!state.existingSessions?.includes(path.id)) throw new Error('session not found');
        return { data: { id: path.id } };
      },
      prompt: async ({ path, body }) => {
        const first = body?.parts[0];
        const text = first?.type === 'text' ? first.text : '';
        state.prompts.push({ sessionId: path.id, agent: body?.agent, text });
        return { data: { info: {}, parts: state.replyText ? [{ type: 'text', text: state.replyText }] : [] } };
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

test('startOpenCodeServerTask reports failed when prompt() resolves but the SSE stream emits session.error', async () => {
  // Regression test: the opencode HTTP client's `prompt()` call can resolve
  // without throwing even though the server failed internally to process the
  // turn. The fake client below mimics exactly that — `prompt` resolves
  // cleanly — while the SSE stream still emits a `session.error` event, which
  // must override the otherwise-successful result.
  const state: FakeClientState = { sessionCreates: [], prompts: [], aborts: [] };
  const sse = (async function* stream(): AsyncGenerator<OpenCodeEvent, void, unknown> {
    yield {
      type: 'session.error',
      properties: {
        sessionID: 'ses_worker_1',
        error: { name: 'UnknownError', data: { message: 'UnknownError' } },
      },
    } as unknown as OpenCodeEvent;
  })();

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createClient: () => createFakeClient(state, sse),
  });
  const result = await live.done;

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /UnknownError|Session error/);
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

test('startOpenCodeServerTask keeps a managed server alive after prompt completion', async () => {
  const spawned = new FakeOpenCodeProcess();
  const state: FakeClientState = { sessionCreates: [], prompts: [], aborts: [] };

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    managedServer: spawned,
    sendEvent: async () => {},
    createClient: () => createFakeClient(state),
  });

  await live.done;

  assert.equal(spawned.killCalled, false);
});

test('startOpenCodeServerTask keeps a managed server alive when aborting the session', async () => {
  const spawned = new FakeOpenCodeProcess();
  const state: FakeClientState = { sessionCreates: [], prompts: [], aborts: [] };

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    managedServer: spawned,
    sendEvent: async () => {},
    createClient: () => createFakeClient(state),
  });

  await live.abort();

  assert.equal(spawned.killCalled, false);
  assert.deepEqual(state.aborts, ['ses_worker_1']);
});

test('startOpenCodeServerTask stops a managed server on worker shutdown signal', async () => {
  const spawned = new FakeOpenCodeProcess();
  const state: FakeClientState = { sessionCreates: [], prompts: [], aborts: [] };

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    managedServer: spawned,
    sendEvent: async () => {},
    createClient: () => createFakeClient(state),
  });

  await live.shutdown();

  assert.equal(spawned.killCalled, true);
  await live.done;
});

test('startOpenCodeServerTask reports awaiting_input when the agent ends with a blocking question', async () => {
  const state: FakeClientState = {
    sessionCreates: [],
    prompts: [],
    aborts: [],
    replyText: 'I looked at /tmp/workspace/api.\nNEEDS_INPUT: Which API version should the client target?',
  };

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createClient: () => createFakeClient(state),
  });
  const result = await live.done;

  assert.equal(result.status, 'awaiting_input');
  assert.equal(result.question, 'Which API version should the client target?');
});

test('startOpenCodeServerTask resumes the paused session with the human answer', async () => {
  const state: FakeClientState = { sessionCreates: [], prompts: [], aborts: [], existingSessions: ['ses_paused'] };

  const live = await startOpenCodeServerTask({
    task: { ...task, resume: { sessionId: 'ses_paused', question: 'Which API version?', answer: 'Use v2' } },
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createClient: () => createFakeClient(state),
  });
  const result = await live.done;

  assert.equal(result.status, 'complete');
  assert.equal(live.sessionId, 'ses_paused');
  assert.deepEqual(state.sessionCreates, []);
  assert.equal(state.prompts.length, 1);
  assert.equal(state.prompts[0]?.sessionId, 'ses_paused');
  assert.match(state.prompts[0]?.text ?? '', /Answer to your question: Use v2/);
});

test('startOpenCodeServerTask carries the question and answer into a new session when the paused one is gone', async () => {
  const state: FakeClientState = { sessionCreates: [], prompts: [], aborts: [] };

  const live = await startOpenCodeServerTask({
    task: { ...task, resume: { sessionId: 'ses_missing', question: 'Which API version?', answer: 'Use v2' } },
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createClient: () => createFakeClient(state),
  });
  await live.done;

  assert.equal(live.sessionId, 'ses_worker_1');
  assert.deepEqual(state.sessionCreates, ['Implement local runner seam']);
  assert.match(state.prompts[0]?.text ?? '', /Task title: Implement local runner seam/);
  assert.match(state.prompts[0]?.text ?? '', /Your question: Which API version\?/);
  assert.match(state.prompts[0]?.text ?? '', /Answer: Use v2/);
});
