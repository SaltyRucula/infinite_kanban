import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';
import {
  ClaudeProvider, CopilotProvider, GrokProvider, HermesProvider, OpenClawProvider,
} from '@codewithdan/agent-sdk-core/providers';
import type { AgentEvent, AgentSessionConfig } from '@codewithdan/agent-sdk-core/types';
import type { OpenCodeAdapter, SpawnedOpenCodeServer } from '@ai-agent-board/opencode-compat';
import type { ExecutionEndpointConfig, HarnessInput, HarnessProgress } from '../../src/execution-types.js';

let adapter: OpenCodeAdapter;
let apiVersion: 1 | 2 = 2;
let kills = 0;
mock.module('@ai-agent-board/opencode-compat', {
  namedExports: {
    createV1Adapter: () => adapter,
    createV2Adapter: () => adapter,
    spawnOpenCodeServer: async () => ({
      apiVersion, baseUrl: 'http://localhost:1234', serverPassword: 'generated-server-secret',
      process: { kill: () => { kills += 1; return true; } },
    } as SpawnedOpenCodeServer),
  },
});
const { resolveHarness } = await import('../../src/harness-registry.js');

const config: ExecutionEndpointConfig = {
  harness: 'copilot', roles: ['implementation'], projects: [], repositories: {},
  stateDirectory: '/local/state', capabilities: [], checks: [],
};
function input(onProgress: HarnessInput['onProgress'], signal?: AbortSignal): HarnessInput {
  return { directory: '/host/worktree', prompt: 'do the work', readOnly: false,
    deadline: Date.now() + 10_000, onProgress, signal };
}
function event(type: AgentEvent['type'], content: string, metadata?: AgentEvent['metadata']): AgentEvent {
  return { id: 'event', contextId: 'session', timestamp: Date.now(), type, content, metadata };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const [name, Provider] of [
  ['copilot', CopilotProvider], ['claude', ClaudeProvider], ['hermes', HermesProvider],
  ['openclaw', OpenClawProvider], ['grok', GrokProvider],
] as const) {
  test(`${name} forwards SDK events through resolveHarness before completion and preserves final text`, async (t) => {
    const release = deferred();
    const reported = deferred();
    const progress: HarnessProgress[] = [];
    const expected: HarnessProgress['type'][] = [
      'thinking', 'tool_call', 'tool_call', 'file_write', 'file_write', 'command',
      'command_output', 'command_output', 'output', 'output', 'output', 'output', 'output', 'output',
    ];
    const events = [
      event('thinking', 'planning'), event('tool_call', 'searching'), event('file_read', 'read add.ts'),
      event('file_write', 'write add.ts'), event('file_edit', 'edit add.ts'), event('command', 'node --test'),
      event('command_output', 'tests ran'), event('test_result', 'tests passed'),
      event('error', 'recoverable error'), event('complete', 'finished'),
      event('output', 'a'), event('output', 'ab'), event('output', 'c'),
      event('output', '{"summary":"done"}', { replace: true }),
    ];
    t.mock.method(Provider.prototype, 'start', async () => {});
    const stop = t.mock.method(Provider.prototype, 'stop', async () => {});
    const destroy = t.mock.fn(async () => {});
    t.mock.method(Provider.prototype, 'createSession', async (sessionConfig: AgentSessionConfig) => ({
      sessionId: 'session',
      async execute() {
        for (const e of events) sessionConfig.onEvent(e);
        reported.resolve();
        await release.promise;
        return { status: 'complete' as const };
      },
      send: async () => {}, abort: async () => {}, destroy,
    }));
    const run = resolveHarness(name)(config)(input((entry) => { progress.push(entry); }));
    try {
      await reported.promise;
      assert.deepEqual(progress.map((entry) => entry.type), expected);
      assert.deepEqual(progress.map((entry) => entry.content), events.map((entry) => entry.content));
    } finally { release.resolve(); }
    assert.equal(await run, '{"summary":"done"}');
    assert.equal(stop.mock.callCount(), 1);
    assert.equal(destroy.mock.callCount(), 1);
  });
}

test('provider progress redacts secrets and host paths, caps entries, and leaves final text intact', async (t) => {
  const previous = process.env.HARNESS_TEST_TOKEN;
  process.env.HARNESS_TEST_TOKEN = 'opaque-credential-value';
  t.after(() => {
    if (previous === undefined) delete process.env.HARNESS_TEST_TOKEN;
    else process.env.HARNESS_TEST_TOKEN = previous;
  });
  const raw = 'opaque-credential-value API_KEY="unknown-value" Bearer bearer-value '
    + 'https://user:private@example.com/a /host/worktree/add.ts /other/host/file '
    + 'C:\\Users\\someone\\file \\\\host\\share\\file ' + 'x'.repeat(2500);
  t.mock.method(CopilotProvider.prototype, 'start', async () => {});
  t.mock.method(CopilotProvider.prototype, 'stop', async () => {});
  t.mock.method(CopilotProvider.prototype, 'createSession', async (session: AgentSessionConfig) => ({
    sessionId: 'session', execute: async () => {
      session.onEvent(event('output', raw, { command: 'metadata-secret' }));
      return { status: 'complete' as const };
    },
    send: async () => {}, abort: async () => {}, destroy: async () => {},
  }));
  const progress: HarnessProgress[] = [];
  assert.equal(await resolveHarness('copilot')(config)(input((entry) => { progress.push(entry); })), raw);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].content.length, 2000);
  for (const secret of ['opaque-credential-value', 'unknown-value', 'bearer-value', 'private',
    '/host/worktree', '/other/host/file', 'someone', 'share', 'metadata-secret']) {
    assert.ok(!progress[0].content.includes(secret), `leaked ${secret}`);
  }
  assert.deepEqual(Object.keys(progress[0]).sort(), ['content', 'type']);
  assert.equal(await resolveHarness('copilot')(config)(input(() => { throw new Error('callback failed'); })), raw);
});

function setupAdapter(t: TestContext) {
  kills = 0;
  const completed = deferred<{ text: string; finalText?: string; error?: string }>();
  const started = deferred();
  const unsubscribed = deferred();
  let subscriptionSignal: AbortSignal | undefined;
  adapter = {
    apiVersion, createSession: async () => 'session',
    getSession: async () => { throw new Error('unexpected getSession'); },
    listSessions: async () => { throw new Error('unexpected listSessions'); },
    pendingQuestions: async () => { throw new Error('unexpected pendingQuestions'); },
    settleQuestion: async () => { throw new Error('unexpected settleQuestion'); },
    runTurn: async () => { started.resolve(); return completed.promise; },
    deleteSession: t.mock.fn(async () => {}), interrupt: t.mock.fn(async () => {}),
    async *subscribe(id, signal) {
      assert.equal(id, 'session');
      subscriptionSignal = signal;
      try {
        await started.promise;
        yield event('thinking', 'reading /host/worktree/add.ts generated-server-secret');
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        yield event('output', 'late event');
      } finally { unsubscribed.resolve(); }
    },
  };
  return { completed, unsubscribed, signal: () => subscriptionSignal };
}

for (const version of [1, 2] as const) {
  test(`OpenCode v${version} subscribes concurrently, reports progress, and stops on completion`, async (t) => {
    apiVersion = version;
    const stub = setupAdapter(t);
    const first = deferred();
    const progress: HarnessProgress[] = [];
    const run = resolveHarness('opencode')(config)(input((entry) => { progress.push(entry); first.resolve(); }));
    await first.promise;
    assert.deepEqual(progress, [{ type: 'thinking', content: 'reading [local workspace]/add.ts [redacted]' }]);
    stub.completed.resolve({ text: 'partial', finalText: '{"summary":"done"}' });
    assert.equal(await run, '{"summary":"done"}');
    await stub.unsubscribed.promise;
    assert.equal(stub.signal()?.aborted, true);
    assert.equal(progress.length, 1);
    assert.equal(kills, 1);
  });
}

test('OpenCode stops progress on caller abort even while runTurn is pending', async (t) => {
  const stub = setupAdapter(t);
  const controller = new AbortController();
  const first = deferred();
  const progress: HarnessProgress[] = [];
  const run = resolveHarness('opencode')(config)(input((entry) => { progress.push(entry); first.resolve(); }, controller.signal));
  await first.promise;
  controller.abort();
  await stub.unsubscribed.promise;
  assert.equal(stub.signal()?.aborted, true);
  assert.equal(progress.length, 1);
  stub.completed.resolve({ text: 'done' });
  assert.equal(await run, 'done');
});

for (const synchronous of [true, false]) {
  test(`OpenCode subscription ${synchronous ? 'setup' : 'iteration'} failure never fails the turn`, async (t) => {
    const stub = setupAdapter(t);
    adapter.subscribe = synchronous
      ? () => { throw new Error('subscribe failed'); }
      : async function* () { throw new Error('stream failed'); };
    stub.completed.resolve({ text: 'done' });
    assert.equal(await resolveHarness('opencode')(config)(input(() => {})), 'done');
  });
}

test('OpenCode turn failure also aborts the subscription', async (t) => {
  const stub = setupAdapter(t);
  const first = deferred();
  const run = resolveHarness('opencode')(config)(input(() => { first.resolve(); }));
  const failure = assert.rejects(run, /turn failed/);
  await first.promise;
  stub.completed.resolve({ text: '', error: 'turn failed' });
  await failure;
  await stub.unsubscribed.promise;
  assert.equal(stub.signal()?.aborted, true);
});
