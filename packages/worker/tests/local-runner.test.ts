import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import type { CoreEvent, OpenCodeAdapter, SessionSpec, TurnOpts, TurnResult } from '@ai-agent-board/opencode-compat';
import {
  parseWorkspaceSettings,
  startOpenCodeServerTask,
  type CreateOpenCodeAdapter,
  type OpenCodeProcess,
  type OpenCodeSpawn,
} from '../src/local-runner.js';
import { INPUT_REQUEST_MARKER } from '../src/input-request.js';

const task: WorkerTaskAssignment = {
  id: 'task-1',
  title: 'Implement local runner seam',
  description: 'Wire worker to opencode run with a local profile',
  priority: 'high',
  labels: ['orioninit', 'worker-local'],
  agentType: 'opencode',
  project: {
    goal: 'Ship a reliable board for distributed engineering teams.',
    context: 'Replace the manual spreadsheet workflow without disrupting users.',
  },
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

// Chunk 0 coverage: a minimal `/api/info` stub used to positively/negatively
// identify an opencode v2 server without ever spawning a real `opencode`
// binary in tests. `startOpenCodeServerTask`'s spawnFn seam lets the fake
// startup banner point at this stub's real (loopback, ephemeral-port) HTTP
// server, so the production probe code (now in @ai-agent-board/opencode-compat)
// makes a real network request against it exactly as it would against a
// real `opencode serve`.
function startInfoStub(
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/info') {
        respond(req, res);
      } else {
        res.writeHead(404).end();
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to bind /api/info stub server'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((res) => { server.close(() => res()); }),
      });
    });
  });
}

type V2StubRequest = { readonly method: string; readonly url: string; readonly body: unknown };

/**
 * A minimal real `node:http` v2 server stub: enough of `/api/info`,
 * `/api/session`, `/api/event` (SSE), and `.../prompt` for
 * `startOpenCodeServerTask`'s real, unmodified `defaultCreateAdapter` to
 * spawn, detect v2, and drive a full turn through `createV2Adapter` end to
 * end — this is what proves the production wiring path (the one cli.ts
 * always takes, never overriding `createAdapter`) actually selects and
 * runs the v2 adapter instead of merely accepting a hand-supplied
 * `apiVersion` on a fake.
 */
function startV2Stub(): Promise<{
  readonly url: string;
  readonly requests: readonly V2StubRequest[];
  emit(data: unknown): void;
  close(): Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const requests: V2StubRequest[] = [];
    let sseRes: http.ServerResponse | undefined;
    const server = http.createServer((req, res) => {
      void (async (): Promise<void> => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const body: unknown = rawBody ? JSON.parse(rawBody) : undefined;
        const url = req.url ?? '';
        const method = req.method ?? '';
        requests.push({ method, url, body });

        if (method === 'GET' && url === '/api/info') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ version: '2.0.12', pid: 12345, urls: [], paths: {} }));
          return;
        }
        if (method === 'GET' && url === '/api/event') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
          res.flushHeaders();
          sseRes = res;
          return;
        }
        if (method === 'POST' && url === '/api/session') {
          const title = (body as { title?: string } | undefined)?.title ?? '';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: { id: 'ses_v2_1', title, time: { created: 0, updated: 0 } } }));
          return;
        }
        if (method === 'PUT' && url.includes('/instructions/entries/')) {
          res.writeHead(204);
          res.end();
          return;
        }
        if (method === 'POST' && url.endsWith('/prompt')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        if (method === 'POST' && url.endsWith('/interrupt')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ interrupted: true }));
          return;
        }
        if (method === 'GET' && /\/api\/session\/[^/]+$/.test(url)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: { id: url.split('/').pop() } }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'not found in stub' }));
      })();
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to bind v2 stub server'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        emit: (data: unknown) => {
          if (!sseRes) throw new Error('v2 stub: no SSE client connected yet');
          sseRes.write(`data: ${JSON.stringify(data)}\n\n`);
        },
        close: () => new Promise((res) => {
          sseRes?.end();
          (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
          server.close(() => res());
        }),
      });
    });
  });
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

type FakeAdapterState = {
  readonly sessionCreates: SessionSpec[];
  readonly turns: Array<{ sessionId: string; agent?: string; systemPrompt?: string | null; disabledTools?: Readonly<Record<string, boolean>>; text: string }>;
  readonly interrupts: string[];
  readonly existingSessions?: readonly string[];
  readonly replyText?: string;
};

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          return { value: undefined, done: true };
        },
      };
    },
  };
}

// Builds a fake OpenCodeAdapter driving the same assertions the pre-adapter
// tests made against a fake raw OpenCodeClientLike, now expressed against
// the abstract adapter contract local-runner.ts actually depends on.
// `apiVersion` defaults to 1 (every existing call site is unaffected); pass
// 2 to simulate a fake v2 adapter (see the awaiting_input parity test
// below) without needing a real v2 HTTP stub for that scenario.
function createFakeAdapter(
  state: FakeAdapterState,
  events: AsyncIterable<CoreEvent> = emptyAsyncIterable<CoreEvent>(),
  apiVersion: 1 | 2 = 1,
): OpenCodeAdapter {
  return {
    apiVersion,
    async createSession(spec: SessionSpec): Promise<string> {
      state.sessionCreates.push(spec);
      return 'ses_worker_1';
    },
    async getSession(id: string): Promise<string | null> {
      return state.existingSessions?.includes(id) ? id : null;
    },
    async listSessions() {
      return [];
    },
    async deleteSession(): Promise<void> {},
    async runTurn(id: string, text: string, opts: TurnOpts = {}): Promise<TurnResult> {
      state.turns.push({
        sessionId: id,
        agent: opts.agent,
        systemPrompt: opts.systemPrompt,
        disabledTools: opts.disabledTools,
        text,
      });
      return { text: state.replyText ?? '' };
    },
    async interrupt(id: string): Promise<void> {
      state.interrupts.push(id);
    },
    subscribe(): AsyncIterable<CoreEvent> {
      return events;
    },
    async pendingQuestions() {
      return [];
    },
    async settleQuestion(): Promise<void> {},
  };
}

test('startOpenCodeServerTask starts a task-titled session and prompts with the configured agent', async () => {
  const spawned = new FakeOpenCodeProcess();
  const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [] };

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

  const createAdapter: CreateOpenCodeAdapter = (config) => {
    assert.equal(config.baseUrl, 'http://127.0.0.1:4096');
    assert.equal(config.directory, '/tmp/workspace');
    return createFakeAdapter(state);
  };

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    sendEvent: async () => {},
    spawnFn,
    createAdapter,
  });
  const result = await live.done;

  assert.equal(live.baseUrl, 'http://127.0.0.1:4096');
  assert.equal(live.sessionId, 'ses_worker_1');
  assert.equal(state.sessionCreates.length, 1);
  assert.equal(state.sessionCreates[0]?.title, 'Implement local runner seam');
  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0]?.sessionId, 'ses_worker_1');
  assert.equal(state.turns[0]?.agent, 'sisyphus');
  assert.equal(state.turns[0]?.text, [
    'Project goal: Ship a reliable board for distributed engineering teams.',
    '',
    'Project context: Replace the manual spreadsheet workflow without disrupting users.',
    '',
    'Task title: Implement local runner seam',
    '',
    'Task description: Wire worker to opencode run with a local profile',
    '',
    'Labels: orioninit, worker-local',
  ].join('\n'));
  assert.equal(result.status, 'complete');
});

// --- Chunk 0: opencode v1/v2 fail-fast coverage (now via spawnOpenCodeServer, exercised through local-runner's public seam) ---

test('startOpenCodeServerTask resolves the URL from a v2-style banner (no "opencode " prefix)', async () => {
  const spawned = new FakeOpenCodeProcess();
  const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [] };

  const spawnFn: OpenCodeSpawn = () => {
    queueMicrotask(() => {
      // v2 dropped the "opencode " prefix from the startup banner; the
      // union regex in opencode-compat's spawn.ts must still resolve this
      // correctly.
      spawned.stdout.write('server listening on http://127.0.0.1:4097\n');
      spawned.stdout.end();
      spawned.stderr.end();
    });
    return spawned;
  };

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    sendEvent: async () => {},
    spawnFn,
    createAdapter: () => createFakeAdapter(state),
  });
  const result = await live.done;

  // Nothing is actually listening on :4097, so the /api/info probe sees a
  // connection error and correctly falls through to "v1, continue".
  assert.equal(live.baseUrl, 'http://127.0.0.1:4097');
  assert.equal(result.status, 'complete');
});

test('startOpenCodeServerTask injects a fresh OPENCODE_SERVER_PASSWORD env var on every spawn', async () => {
  const passwords: string[] = [];
  const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [] };

  const runOnce = async (port: number): Promise<void> => {
    const spawned = new FakeOpenCodeProcess();
    const spawnFn: OpenCodeSpawn = (_command, _args, options) => {
      const env = options.env as Record<string, string | undefined> | undefined;
      const password = env?.OPENCODE_SERVER_PASSWORD;
      assert.equal(typeof password, 'string');
      passwords.push(password as string);
      // OPENCODE_PERMISSION must still be present alongside the new var —
      // this is an addition, not a replacement, of the spawn env.
      assert.equal(typeof env?.OPENCODE_PERMISSION, 'string');
      queueMicrotask(() => {
        spawned.stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`);
        spawned.stdout.end();
        spawned.stderr.end();
      });
      return spawned;
    };

    const live = await startOpenCodeServerTask({
      task,
      workspacePath: '/tmp/workspace',
      runner: { kind: 'opencode-server', agent: 'sisyphus' },
      sendEvent: async () => {},
      spawnFn,
      createAdapter: () => createFakeAdapter(state),
    });
    await live.done;
  };

  await runOnce(4098);
  await runOnce(4099);

  assert.equal(passwords.length, 2);
  assert.ok(passwords[0].length >= 32, `expected password length >= 32, got ${passwords[0].length}`);
  assert.ok(passwords[1].length >= 32, `expected password length >= 32, got ${passwords[1].length}`);
  assert.notEqual(passwords[0], passwords[1]);
});

test('startOpenCodeServerTask selects the v2 adapter (no createAdapter override) when /api/info reports v2, and completes a real turn against it', async () => {
  const stub = await startV2Stub();
  try {
    const spawned = new FakeOpenCodeProcess();
    const spawnFn: OpenCodeSpawn = () => {
      queueMicrotask(() => {
        spawned.stdout.write(`server listening on ${stub.url}\n`);
        spawned.stdout.end();
        spawned.stderr.end();
      });
      return spawned;
    };

    // Deliberately no `createAdapter` override — this exercises
    // `startOpenCodeServerTask`'s real, production default-wiring path
    // (spawnOpenCodeServer's apiVersion probe -> defaultCreateAdapter's
    // v1/v2 selection -> createV2Adapter), the exact path cli.ts always
    // takes. Chunk 4 flips this from "fatal on v2" to "actually runs".
    const live = await startOpenCodeServerTask({
      task,
      workspacePath: '/tmp/workspace',
      runner: { kind: 'opencode-server', agent: 'sisyphus' },
      sendEvent: async () => {},
      spawnFn,
    });

    setTimeout(() => {
      stub.emit({ type: 'session.text.ended', data: { sessionID: 'ses_v2_1', assistantMessageID: 'm1', ordinal: 0, text: 'All done' } });
      stub.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_v2_1' } });
    }, 50);

    const result = await live.done;

    assert.equal(live.sessionId, 'ses_v2_1');
    assert.equal(result.status, 'complete');
    // Confirms genuinely v2-shaped requests were made (v1's SDK would hit
    // unprefixed `/session`, never `/api/session`).
    assert.ok(stub.requests.some((r) => r.method === 'POST' && r.url === '/api/session'), 'expected a v2-shaped POST /api/session');
    assert.ok(stub.requests.some((r) => r.method === 'POST' && r.url.endsWith('/prompt')), 'expected a v2-shaped prompt POST');
    assert.ok(stub.requests.some((r) => r.method === 'GET' && r.url === '/api/event'), 'expected the v2 SSE stream to be opened');
  } finally {
    await stub.close();
  }
});

test('startOpenCodeServerTask proceeds as v1 when /api/info responds 404', async () => {
  const stub = await startInfoStub((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  try {
    const spawned = new FakeOpenCodeProcess();
    const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [] };
    const spawnFn: OpenCodeSpawn = () => {
      queueMicrotask(() => {
        spawned.stdout.write(`opencode server listening on ${stub.url}\n`);
        spawned.stdout.end();
        spawned.stderr.end();
      });
      return spawned;
    };

    const live = await startOpenCodeServerTask({
      task,
      workspacePath: '/tmp/workspace',
      runner: { kind: 'opencode-server', agent: 'sisyphus' },
      sendEvent: async () => {},
      spawnFn,
      createAdapter: () => createFakeAdapter(state),
    });
    const result = await live.done;

    assert.equal(live.baseUrl, stub.url);
    assert.equal(result.status, 'complete');
  } finally {
    await stub.close();
  }
});

test('startOpenCodeServerTask throws on a 401 from /api/info without ever assuming v1', async () => {
  const stub = await startInfoStub((_req, res) => {
    res.writeHead(401);
    res.end();
  });
  try {
    const spawned = new FakeOpenCodeProcess();
    const spawnFn: OpenCodeSpawn = () => {
      queueMicrotask(() => {
        spawned.stdout.write(`opencode server listening on ${stub.url}\n`);
        spawned.stdout.end();
        spawned.stderr.end();
      });
      return spawned;
    };

    await assert.rejects(
      startOpenCodeServerTask({
        task,
        workspacePath: '/tmp/workspace',
        runner: { kind: 'opencode-server', agent: 'sisyphus' },
        sendEvent: async () => {},
        spawnFn,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /401/);
        // The whole point of this guard: a rejected-credentials probe must
        // never be silently downgraded to "assume v1".
        assert.doesNotMatch(error.message, /assume v1|v1 only/i);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test('startOpenCodeServerTask redacts a leaked server password from a startup-crash error', async () => {
  const spawned = new FakeOpenCodeProcess();
  const spawnFn: OpenCodeSpawn = () => {
    queueMicrotask(() => {
      // Simulates v2 printing its auto-generated password line (the leak
      // this change fixes) followed by an unexpected crash before startup
      // completes.
      spawned.stdout.write('server password hunter2\n');
      spawned.emit('close', 1, null);
    });
    return spawned;
  };

  await assert.rejects(
    startOpenCodeServerTask({
      task,
      workspacePath: '/tmp/workspace',
      runner: { kind: 'opencode-server', agent: 'sisyphus' },
      sendEvent: async () => {},
      spawnFn,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /hunter2/);
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});

test('startOpenCodeServerTask streams mapped SSE events and strips local workspace paths', async () => {
  const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [] };
  const events = (async function* stream(): AsyncGenerator<CoreEvent, void, unknown> {
    yield {
      id: 'evt-1',
      contextId: 'ses_worker_1',
      type: 'output',
      content: 'Path /tmp/workspace/README.md',
      timestamp: Date.now(),
    };
  })();
  const contents: string[] = [];

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async (event) => {
      contents.push(event.content);
    },
    createAdapter: () => createFakeAdapter(state, events),
  });
  await live.done;

  assert.equal(contents.some((value) => value.includes('[local workspace]')), true);
});

test('startOpenCodeServerTask reports failed when runTurn() resolves but the SSE stream emits an error event', async () => {
  // Regression test: the opencode adapter's `runTurn()` call can resolve
  // without throwing even though the server failed internally to process
  // the turn. The fake adapter below mimics exactly that — `runTurn`
  // resolves cleanly — while the event stream still emits an error-typed
  // core event, which must override the otherwise-successful result.
  const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [] };
  const events = (async function* stream(): AsyncGenerator<CoreEvent, void, unknown> {
    yield {
      id: 'evt-1',
      contextId: 'ses_worker_1',
      type: 'error',
      content: 'UnknownError',
      timestamp: Date.now(),
    };
  })();

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createAdapter: () => createFakeAdapter(state, events),
  });
  const result = await live.done;

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /UnknownError/);
});


test('startOpenCodeServerTask forwards follow-up messages and abort to the same session', async () => {
  const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [] };
  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createAdapter: () => createFakeAdapter(state),
  });

  await live.sendMessage('Need clarification details');
  await live.abort();
  await live.done;

  assert.equal(state.turns.length, 2);
  assert.equal(state.turns[1]?.sessionId, 'ses_worker_1');
  assert.equal(state.turns[1]?.text, 'Need clarification details');
  // Follow-up turns deliberately omit the system prompt (see local-runner.ts).
  assert.equal(state.turns[1]?.systemPrompt, null);
  assert.deepEqual(state.interrupts, ['ses_worker_1']);
});

test('startOpenCodeServerTask keeps a managed server alive after prompt completion', async () => {
  const spawned = new FakeOpenCodeProcess();
  const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [] };

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    managedServer: spawned,
    sendEvent: async () => {},
    createAdapter: () => createFakeAdapter(state),
  });

  await live.done;

  assert.equal(spawned.killCalled, false);
});

test('startOpenCodeServerTask keeps a managed server alive when aborting the session', async () => {
  const spawned = new FakeOpenCodeProcess();
  const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [] };

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    managedServer: spawned,
    sendEvent: async () => {},
    createAdapter: () => createFakeAdapter(state),
  });

  await live.abort();

  assert.equal(spawned.killCalled, false);
  assert.deepEqual(state.interrupts, ['ses_worker_1']);
});

test('startOpenCodeServerTask stops a managed server on worker shutdown signal', async () => {
  const spawned = new FakeOpenCodeProcess();
  const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [] };

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    managedServer: spawned,
    sendEvent: async () => {},
    createAdapter: () => createFakeAdapter(state),
  });

  await live.shutdown();

  assert.equal(spawned.killCalled, true);
  await live.done;
});

test('startOpenCodeServerTask reports awaiting_input when the agent ends with a blocking question', async () => {
  const state: FakeAdapterState = {
    sessionCreates: [],
    turns: [],
    interrupts: [],
    replyText: 'I looked at /tmp/workspace/api.\nNEEDS_INPUT: Which API version should the client target?',
  };

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createAdapter: () => createFakeAdapter(state),
  });
  const result = await live.done;

  assert.equal(result.status, 'awaiting_input');
  assert.equal(result.question, 'Which API version should the client target?');
});

// Chunk 4 parity: a v2 turn that parks on a form/permission mid-turn
// resolves `runTurn` with the same NEEDS_INPUT: marker convention v1's
// model output already uses (see createV2Adapter's module doc comment in
// opencode-compat) — this fake v2 adapter (apiVersion: 2) simulates exactly
// that resolved TurnResult, without needing a real v2 HTTP stub, to prove
// the flow into `awaiting_input` task state is IDENTICAL for v1 and v2:
// local-runner.ts's extractInputRequest/awaiting_input handling neither
// knows nor cares which apiVersion produced the marker.
test('startOpenCodeServerTask: a parked v2 turn flows into the same awaiting_input state as v1 (fake v2 adapter)', async () => {
  const state: FakeAdapterState = {
    sessionCreates: [],
    turns: [],
    interrupts: [],
    replyText: 'NEEDS_INPUT: Permission requested: external_directory (/etc/*)',
  };

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createAdapter: () => createFakeAdapter(state, undefined, 2),
  });
  const result = await live.done;

  assert.equal(result.status, 'awaiting_input');
  assert.equal(result.question, 'Permission requested: external_directory (/etc/*)');
});

test('startOpenCodeServerTask resumes the paused session with the human answer', async () => {
  const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [], existingSessions: ['ses_paused'] };

  const live = await startOpenCodeServerTask({
    task: { ...task, resume: { sessionId: 'ses_paused', question: 'Which API version?', answer: 'Use v2' } },
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createAdapter: () => createFakeAdapter(state),
  });
  const result = await live.done;

  assert.equal(result.status, 'complete');
  assert.equal(live.sessionId, 'ses_paused');
  assert.equal(state.sessionCreates.length, 0);
  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0]?.sessionId, 'ses_paused');
  assert.match(state.turns[0]?.text ?? '', /Answer to your question: Use v2/);
});

test('startOpenCodeServerTask carries the question and answer into a new session when the paused one is gone', async () => {
  const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [] };

  const live = await startOpenCodeServerTask({
    task: { ...task, resume: { sessionId: 'ses_missing', question: 'Which API version?', answer: 'Use v2' } },
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createAdapter: () => createFakeAdapter(state),
  });
  await live.done;

  assert.equal(live.sessionId, 'ses_worker_1');
  assert.equal(state.sessionCreates.length, 1);
  assert.equal(state.sessionCreates[0]?.title, 'Implement local runner seam');
  assert.match(state.turns[0]?.text ?? '', /Task title: Implement local runner seam/);
  assert.match(state.turns[0]?.text ?? '', /Your question: Which API version\?/);
  assert.match(state.turns[0]?.text ?? '', /Answer: Use v2/);
});

// SHOULD-FIX 5 regression: resolveSession's adapter.getSession call used to
// go through an `as unknown as OpenCodeClientLike` cast reaching a raw SDK
// client, so an installed SDK version that lacked the method (or otherwise
// threw synchronously when invoked) threw BEFORE a bare `.catch()` on its
// return value could ever see it. That used to reject resolveSession's
// promise and fail the whole task instead of falling back to creating a
// fresh session. The adapter boundary now guarantees getSession always
// returns a promise (even a synchronously-thrown error becomes a rejection,
// per the resolveSession try/catch below), but this regression test is kept
// to guard the fallback behaviour itself.
test('startOpenCodeServerTask falls back to a fresh session when adapter.getSession throws synchronously', async () => {
  const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [] };
  const adapter = createFakeAdapter(state);
  const syncThrowingAdapter: OpenCodeAdapter = {
    ...adapter,
    getSession: () => { throw new TypeError('adapter.getSession is not a function'); },
  };

  const live = await startOpenCodeServerTask({
    task: { ...task, resume: { sessionId: 'ses_paused', question: 'Which API version?', answer: 'Use v2' } },
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createAdapter: () => syncThrowingAdapter,
  });
  const result = await live.done;

  assert.equal(result.status, 'complete');
  assert.equal(live.sessionId, 'ses_worker_1');
  assert.equal(state.sessionCreates.length, 1);
  assert.match(state.turns[0]?.text ?? '', /Your question: Which API version\?/);
  assert.match(state.turns[0]?.text ?? '', /Answer: Use v2/);
});

test('startOpenCodeServerTask runs a review task as a read-only reviewer and reports the verdict', async () => {
  const state: FakeAdapterState = {
    sessionCreates: [],
    turns: [],
    interrupts: [],
    replyText: 'Retry count is 2, expected 3.\nREVIEW_VERDICT: changes_requested',
  };

  const live = await startOpenCodeServerTask({
    task: { ...task, mode: 'review', branchName: 'feature/seam', baseBranch: 'main' },
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createAdapter: () => createFakeAdapter(state),
  });
  const result = await live.done;

  assert.match(state.turns[0]?.text ?? '', /Review the implementation of this task/);
  assert.match(state.turns[0]?.systemPrompt ?? '', /REVIEWER/);
  assert.equal(state.turns[0]?.disabledTools?.edit, false);
  assert.equal(state.turns[0]?.disabledTools?.write, false);
  assert.equal(result.status, 'complete');
  assert.equal(result.reviewVerdict, 'changes_requested');
  assert.equal(result.summary, 'Retry count is 2, expected 3.');
});

test('startOpenCodeServerTask fails a review that ends without a verdict', async () => {
  const state: FakeAdapterState = { sessionCreates: [], turns: [], interrupts: [], replyText: 'Looks fine to me.' };

  const live = await startOpenCodeServerTask({
    task: { ...task, mode: 'review' },
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createAdapter: () => createFakeAdapter(state),
  });
  const result = await live.done;

  assert.equal(result.status, 'failed');
  assert.equal(result.reviewVerdict, undefined);
});

// SHOULD-FIX regression: INPUT_REQUEST_INSTRUCTIONS was included in the
// system prompt on every run, including review runs, giving a reviewer two
// contradictory "end your response with this final line" instructions
// (REVIEW_VERDICT: ... and NEEDS_INPUT: ...). A review run's system prompt
// must never contain the clarification instructions.
test('startOpenCodeServerTask does not include the clarification instructions in a review run\'s system prompt', async () => {
  const state: FakeClientState = {
    sessionCreates: [], prompts: [], aborts: [], bodies: [],
    replyText: 'Looks fine.\nREVIEW_VERDICT: pass',
  };

  const live = await startOpenCodeServerTask({
    task: { ...task, mode: 'review' },
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createClient: () => createFakeClient(state),
  });
  await live.done;

  assert.equal(state.bodies?.[0]?.system?.includes(INPUT_REQUEST_MARKER), false);
  assert.match(state.bodies?.[0]?.system ?? '', /REVIEWER/);
});

test('startOpenCodeServerTask still includes the clarification instructions on a non-review run', async () => {
  const state: FakeClientState = { sessionCreates: [], prompts: [], aborts: [], bodies: [] };

  const live = await startOpenCodeServerTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-server', agent: 'sisyphus' },
    baseUrl: 'http://127.0.0.1:4096',
    sendEvent: async () => {},
    createClient: () => createFakeClient(state),
  });
  await live.done;

  assert.equal(state.bodies?.[0]?.system?.includes(INPUT_REQUEST_MARKER), true);
});

// NIT regression: resolveSession would happily resume a paused session for a
// review-mode task even though startOpenCodeServerTaskWithClient always
// sends buildReviewPrompt (not the resume answer prompt) into a review run —
// silently discarding the resume answer and sending a review prompt into a
// session that was reopened to receive a clarification answer. Unreachable
// today (INPUT_REQUEST_INSTRUCTIONS, the only thing that can make a run ask
// for `resume`, is now gated on `!review`), but this must fail loudly rather
// than silently resuming the wrong session if that invariant is ever broken.
test('startOpenCodeServerTask fails loudly instead of resuming a paused session when a review-mode task carries a resume payload (NIT)', async () => {
  const state: FakeClientState = { sessionCreates: [], prompts: [], aborts: [], existingSessions: ['ses_paused'] };

  await assert.rejects(
    () => startOpenCodeServerTask({
      task: { ...task, mode: 'review', resume: { sessionId: 'ses_paused', question: 'Which API version?', answer: 'Use v2' } },
      workspacePath: '/tmp/workspace',
      runner: { kind: 'opencode-server', agent: 'sisyphus' },
      baseUrl: 'http://127.0.0.1:4096',
      sendEvent: async () => {},
      createClient: () => createFakeClient(state),
    }),
    /task\.resume must never be set on a review-mode task/,
  );
  // The paused session must never be touched (no prompt sent into it).
  assert.deepEqual(state.prompts, []);
});
