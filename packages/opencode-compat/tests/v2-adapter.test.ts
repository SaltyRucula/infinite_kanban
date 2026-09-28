import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import { buildV2PermissionRuleset, createV2Adapter } from '../src/v2-adapter.js';
import type { CoreEvent } from '../src/types.js';

type SseFrame = { readonly data: unknown };

/**
 * A minimal, real `node:http` stub of the pieces of opencode v2's API this
 * adapter talks to. Not a mock of the adapter's own HTTP client — genuine
 * sockets, genuine SSE framing (`data: {...}\n\n`), so a regression in how
 * this adapter parses/sequences requests is caught the same way it would be
 * against a real opencode server.
 */
class StubV2Server {
  private server: Server | undefined;
  private sseRes: ServerResponse | undefined;
  readonly requests: Array<{ method: string; url: string; body: unknown }> = [];

  /** Overridable per-test hooks. */
  onPrompt: (body: unknown) => { status: number; body?: unknown } = () => ({ status: 200, body: { data: { id: 'msg_1' } } });
  onInstructionsPut: () => { status: number } = () => ({ status: 204 });
  onSessionCreate: (body: unknown) => { status: number; body?: unknown } = (body) => ({
    status: 200,
    body: { data: { id: 'ses_test', title: (body as { title?: string })?.title ?? '', time: { created: 0, updated: 0 } } },
  });
  onPermissionReply: (body: unknown) => { status: number; body?: unknown } = () => ({ status: 200, body: { replied: true } });
  onFormReply: (body: unknown) => { status: number; body?: unknown } = () => ({ status: 200, body: { replied: true } });
  onFormDelete: () => { status: number } = () => ({ status: 200 });

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.sseRes?.end();
    const server = this.server;
    if (!server) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // Node's server.close() only refuses new connections; it waits for
    // existing sockets (including keep-alive-pooled ones from `fetch`) to
    // close on their own before invoking its callback. Without forcing
    // them closed here, an idle keep-alive socket from an earlier request
    // in the same test can hang this call — and therefore the whole test
    // file — indefinitely.
    (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await closed;
  }

  /** Pushes one SSE frame down the currently-connected `/api/event` stream, if any. */
  emit(data: unknown): void {
    if (!this.sseRes) throw new Error('stub: no SSE client connected yet');
    this.sseRes.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    const url = req.url ?? '';
    const method = req.method ?? '';
    this.requests.push({ method, url, body });

    if (method === 'GET' && url === '/api/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.flushHeaders();
      this.sseRes = res;
      return;
    }

    if (method === 'POST' && url === '/api/session') {
      const result = this.onSessionCreate(body);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body ? JSON.stringify(result.body) : undefined);
      return;
    }

    if (method === 'PUT' && url.includes('/instructions/entries/')) {
      const result = this.onInstructionsPut();
      res.writeHead(result.status);
      res.end();
      return;
    }

    if (method === 'POST' && url.endsWith('/prompt')) {
      const result = this.onPrompt(body);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body ? JSON.stringify(result.body) : undefined);
      return;
    }

    if (method === 'POST' && url.endsWith('/interrupt')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ interrupted: true }));
      return;
    }

    if (method === 'POST' && /\/permission\/[^/]+\/reply$/.test(url)) {
      const result = this.onPermissionReply(body);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body ? JSON.stringify(result.body) : undefined);
      return;
    }

    if (method === 'POST' && /\/form\/[^/]+\/reply$/.test(url)) {
      const result = this.onFormReply(body);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body ? JSON.stringify(result.body) : undefined);
      return;
    }

    if (method === 'DELETE' && /\/form\/[^/]+$/.test(url)) {
      const result = this.onFormDelete();
      res.writeHead(result.status);
      res.end();
      return;
    }

    if (method === 'GET' && /\/api\/session\/[^/]+$/.test(url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: url.split('/').pop() } }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found in stub' }));
  }
}

function textEnded(sessionID: string, text: string, ordinal = 0, assistantMessageID = 'msg_a'): SseFrame {
  return { data: { type: 'session.text.ended', data: { sessionID, assistantMessageID, ordinal, text } } };
}

function succeeded(sessionID: string): SseFrame {
  return { data: { type: 'session.execution.succeeded', data: { sessionID } } };
}

function failed(sessionID: string, message: string): SseFrame {
  return { data: { type: 'session.execution.failed', data: { sessionID, error: { type: 'provider.error', message } } } };
}

function permissionAsked(sessionID: string, requestID: string, action = 'external_directory', resources: string[] = ['/etc/*']): SseFrame {
  return { data: { type: 'permission.asked', data: { id: requestID, sessionID, action, resources } } };
}

function formCreated(
  sessionID: string,
  formID: string,
  fields: ReadonlyArray<Record<string, unknown>> = [
    { key: 'q0', title: 'New key name', description: 'What should config_key be renamed to?', type: 'string' },
  ],
): SseFrame {
  return { data: { type: 'form.created', data: { form: { id: formID, sessionID, title: 'Questions', fields } } } };
}

function toolInputStarted(sessionID: string, callId: string, name: string, assistantMessageID = 'msg_a'): SseFrame {
  return { data: { type: 'session.tool.input.started', data: { sessionID, assistantMessageID, id: callId, name } } };
}

function toolCalled(sessionID: string, callId: string, input: Record<string, unknown>, assistantMessageID = 'msg_a'): SseFrame {
  return { data: { type: 'session.tool.called', data: { sessionID, assistantMessageID, id: callId, input, executed: false } } };
}

test('runTurn blocks until the SSE terminal event, not until /prompt responds (async-prompt gating)', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw' });
    const id = await adapter.createSession({
      title: 't',
      directory: '/tmp/x',
      headlessPermissions: true,
    });

    const delayMs = 200;
    setTimeout(() => {
      stub.emit(textEnded(id, 'DONE').data);
      stub.emit(succeeded(id).data);
    }, delayMs);

    const start = Date.now();
    const result = await adapter.runTurn(id, 'hello');
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= delayMs - 20, `expected runTurn to block at least ~${delayMs}ms, took ${elapsed}ms`);
    assert.equal(result.text, 'DONE');
    assert.equal(result.error, undefined);

    // The /prompt call itself must have returned near-instantly (well
    // before the SSE delay) — this is the regression this test guards
    // against: if runTurn resolved on the HTTP response instead of the SSE
    // terminal event, `elapsed` above would be near 0, not >= delayMs.
    const promptRequest = stub.requests.find((r) => r.url.endsWith('/prompt'));
    assert.ok(promptRequest, 'expected a /prompt request to have been made');
  } finally {
    await stub.stop();
  }
});

test('createSession sends location.directory and a model shaped {providerID, id} (not modelID)', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw' });
    await adapter.createSession({
      title: 'my session',
      directory: '/tmp/project',
      headlessPermissions: true,
      model: { providerID: 'github-copilot', modelID: 'claude-sonnet-5' },
    });

    const createRequest = stub.requests.find((r) => r.method === 'POST' && r.url === '/api/session');
    assert.ok(createRequest);
    const body = createRequest!.body as Record<string, unknown>;
    assert.deepEqual(body.location, { directory: '/tmp/project' });
    assert.deepEqual(body.model, { providerID: 'github-copilot', id: 'claude-sonnet-5' });
    assert.equal((body.model as Record<string, unknown>).modelID, undefined);
  } finally {
    await stub.stop();
  }
});

test('system prompt lands via Tier 1 PUT .../instructions/entries/headless', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw' });
    await adapter.createSession({
      title: 't',
      directory: '/tmp/x',
      headlessPermissions: true,
      systemPrompt: 'You are a helpful headless agent.',
    });

    const putRequest = stub.requests.find((r) => r.method === 'PUT' && r.url.includes('/instructions/entries/'));
    assert.ok(putRequest, 'expected a PUT to the instructions entries endpoint');
    assert.ok(putRequest!.url.endsWith('/instructions/entries/headless'));
    assert.deepEqual(putRequest!.body, { value: 'You are a helpful headless agent.' });
  } finally {
    await stub.stop();
  }
});

test('Tier 1 PUT returning 404 falls back to prepending into the first prompt only', async () => {
  const stub = new StubV2Server();
  stub.onInstructionsPut = () => ({ status: 404 });
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw' });
    const id = await adapter.createSession({
      title: 't',
      directory: '/tmp/x',
      headlessPermissions: true,
      systemPrompt: 'SYSTEM-TEXT',
    });
    setTimeout(() => stub.emit(succeeded(id).data), 50);
    await adapter.runTurn(id, 'first turn body');

    const firstPrompt = stub.requests.filter((r) => r.url.endsWith('/prompt'))[0];
    assert.ok((firstPrompt.body as { text: string }).text.startsWith('SYSTEM-TEXT'));
    assert.ok((firstPrompt.body as { text: string }).text.includes('first turn body'));

    setTimeout(() => stub.emit(succeeded(id).data), 50);
    await adapter.runTurn(id, 'second turn body');

    const secondPrompt = stub.requests.filter((r) => r.url.endsWith('/prompt'))[1];
    assert.equal((secondPrompt.body as { text: string }).text, 'second turn body');
    assert.ok(!(secondPrompt.body as { text: string }).text.includes('SYSTEM-TEXT'));
  } finally {
    await stub.stop();
  }
});

test('session.execution.failed causes runTurn to return an error', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw' });
    const id = await adapter.createSession({ title: 't', directory: '/tmp/x', headlessPermissions: true });

    setTimeout(() => stub.emit(failed(id, 'provider auth failed').data), 50);
    const result = await adapter.runTurn(id, 'hello');
    assert.equal(result.error, 'provider auth failed');
  } finally {
    await stub.stop();
  }
});

test('interrupt() hits /interrupt and never calls /abort', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw' });
    const id = await adapter.createSession({ title: 't', directory: '/tmp/x', headlessPermissions: true });
    await adapter.interrupt(id);

    assert.ok(stub.requests.some((r) => r.method === 'POST' && r.url.endsWith('/interrupt')));
    assert.ok(!stub.requests.some((r) => r.url.includes('/abort')));
  } finally {
    await stub.stop();
  }
});

test('per-turn deadline: no terminal event ever arrives, runTurn rejects within the bounded deadline', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw', turnDeadlineMs: 150 });
    const id = await adapter.createSession({ title: 't', directory: '/tmp/x', headlessPermissions: true });

    const start = Date.now();
    await assert.rejects(() => adapter.runTurn(id, 'hello'));
    const elapsed = Date.now() - start;

    // Bounded wall-clock assertion: a regression back to "wait forever"
    // would blow well past this, failing fast here instead of timing out
    // the whole suite.
    assert.ok(elapsed < 2000, `expected runTurn to reject quickly, took ${elapsed}ms`);
    assert.ok(elapsed >= 130, `expected runTurn to wait roughly the configured deadline, took ${elapsed}ms`);
  } finally {
    await stub.stop();
  }
});

test('headless permissions ruleset is sent on create', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw' });
    await adapter.createSession({ title: 't', directory: '/tmp/x', headlessPermissions: true });

    const createRequest = stub.requests.find((r) => r.method === 'POST' && r.url === '/api/session');
    const body = createRequest!.body as Record<string, unknown>;
    assert.deepEqual(body.permissions, [{ action: '*', resource: '*', effect: 'allow' }]);
  } finally {
    await stub.stop();
  }
});

test('review-mode ruleset denies edit and shell, and never uses the non-functional "bash" action name', () => {
  const ruleset = buildV2PermissionRuleset(true, { edit: false, write: false, shell: false, question: false });
  assert.ok(ruleset);
  assert.deepEqual(ruleset![0], { action: '*', resource: '*', effect: 'allow' });
  const actions = ruleset!.map((rule) => rule.action);
  assert.ok(actions.includes('edit'));
  assert.ok(actions.includes('shell'));
  assert.ok(!actions.includes('bash'));
  assert.ok(!actions.includes('write')); // write/edit collapse onto the single 'edit' action.
});

test('buildV2PermissionRuleset omits permissions entirely when headlessPermissions is false', () => {
  assert.equal(buildV2PermissionRuleset(false, { edit: false }), undefined);
});

// --- Chunk 4: the anti-hang watcher ---

test('permission.asked mid-turn: adapter rejects the permission AND the turn parks as awaiting_input (bounded wall-clock)', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw', turnDeadlineMs: 5_000 });
    const id = await adapter.createSession({ title: 't', directory: '/tmp/x', headlessPermissions: true });

    // Deliberately never emit a terminal event for this turn — the whole
    // point of this test is that the watcher parks without one.
    setTimeout(() => stub.emit(permissionAsked(id, 'per_1').data), 30);

    const start = Date.now();
    const result = await adapter.runTurn(id, 'hello');
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `expected runTurn to resolve quickly once parked, took ${elapsed}ms (no hang)`);
    assert.ok(result.text.includes('NEEDS_INPUT:'), `expected a NEEDS_INPUT marker, got: ${result.text}`);
    assert.ok(result.text.includes('external_directory'), `expected the permission action in the question, got: ${result.text}`);
    assert.equal(result.error, undefined);

    const replyRequest = stub.requests.find((r) => r.method === 'POST' && r.url.endsWith('/permission/per_1/reply'));
    assert.ok(replyRequest, 'expected a permission reply POST to the right URL');
    assert.deepEqual(replyRequest!.body, { decision: 'reject' });
  } finally {
    await stub.stop();
  }
});

test('form.created mid-turn (single-field form): adapter replies with the known field AND the turn parks as awaiting_input', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw', turnDeadlineMs: 5_000 });
    const id = await adapter.createSession({ title: 't', directory: '/tmp/x', headlessPermissions: true });

    setTimeout(() => stub.emit(formCreated(id, 'frm_1').data), 30);

    const start = Date.now();
    const result = await adapter.runTurn(id, 'hello');
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `expected runTurn to resolve quickly once parked, took ${elapsed}ms (no hang)`);
    assert.ok(result.text.includes('NEEDS_INPUT:'), `expected a NEEDS_INPUT marker, got: ${result.text}`);
    assert.ok(result.text.includes('config_key'), `expected the form question text, got: ${result.text}`);

    const replyRequest = stub.requests.find((r) => r.method === 'POST' && r.url.endsWith('/form/frm_1/reply'));
    assert.ok(replyRequest, 'expected a form reply POST to the right URL');
    assert.deepEqual(replyRequest!.body, { answer: { q0: '' } });
    assert.ok(!stub.requests.some((r) => r.method === 'DELETE'), 'a single-field form must be answered, not deleted');
  } finally {
    await stub.stop();
  }
});

test('form.created mid-turn (multi-field form, unanswerable): adapter DELETEs the form AND the turn still parks', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw', turnDeadlineMs: 5_000 });
    const id = await adapter.createSession({ title: 't', directory: '/tmp/x', headlessPermissions: true });

    const multiFieldForm = formCreated(id, 'frm_2', [
      { key: 'q0', title: 'First name', description: 'What is your first name?', type: 'string' },
      { key: 'q1', title: 'Last name', description: 'What is your last name?', type: 'string' },
    ]);
    setTimeout(() => stub.emit(multiFieldForm.data), 30);

    const result = await adapter.runTurn(id, 'hello');

    assert.ok(result.text.includes('NEEDS_INPUT:'));
    const deleteRequest = stub.requests.find((r) => r.method === 'DELETE' && r.url.endsWith('/form/frm_2'));
    assert.ok(deleteRequest, 'expected the unanswerable multi-field form to be force-closed via DELETE');
    assert.ok(!stub.requests.some((r) => r.method === 'POST' && r.url.includes('/form/frm_2/reply')));
  } finally {
    await stub.stop();
  }
});

test('dropped stream: no terminal event and no input-request ever arrive — runTurn rejects within the bounded deadline, never hangs', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw', turnDeadlineMs: 150 });
    const id = await adapter.createSession({ title: 't', directory: '/tmp/x', headlessPermissions: true });

    const start = Date.now();
    await assert.rejects(() => adapter.runTurn(id, 'hello'));
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `expected runTurn to reject quickly, took ${elapsed}ms`);
    assert.ok(elapsed >= 130, `expected runTurn to wait roughly the configured deadline, took ${elapsed}ms`);
  } finally {
    await stub.stop();
  }
});

test('happy path still gates on session.execution.succeeded (regression guard for the async /prompt contract)', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw' });
    const id = await adapter.createSession({ title: 't', directory: '/tmp/x', headlessPermissions: true });

    const delayMs = 150;
    setTimeout(() => {
      stub.emit(textEnded(id, 'All done').data);
      stub.emit(succeeded(id).data);
    }, delayMs);

    const start = Date.now();
    const result = await adapter.runTurn(id, 'hello');
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= delayMs - 20, `expected runTurn to block until the terminal event, took ${elapsed}ms`);
    assert.equal(result.text, 'All done');
    assert.equal(result.error, undefined);
    assert.ok(!result.text.includes('NEEDS_INPUT:'));
  } finally {
    await stub.stop();
  }
});

test('subscribe() yields mapped CoreEvents (not raw v2 envelopes) and drops events that map to null', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw' });
    const id = await adapter.createSession({ title: 't', directory: '/tmp/x', headlessPermissions: true });

    const controller = new AbortController();
    const received: CoreEvent[] = [];
    const iterate = (async () => {
      for await (const event of adapter.subscribe(id, controller.signal)) {
        received.push(event);
        if (received.length >= 1) break;
      }
    })();

    // session.instructions.updated maps to null (telemetry, see v2-events.ts)
    // and must never surface to a subscribe() consumer.
    setTimeout(() => {
      stub.emit({ type: 'session.instructions.updated', data: { sessionID: id } });
      stub.emit({ type: 'session.text.delta', data: { sessionID: id, delta: 'hi there' } });
    }, 30);

    await iterate;
    controller.abort();

    assert.equal(received.length, 1);
    assert.equal(received[0]?.type, 'output');
    assert.equal(received[0]?.content, 'hi there');
    // Raw envelope fields (id/created/location/durable) must never leak
    // through onto the mapped CoreEvent shape.
    assert.equal((received[0] as unknown as { location?: unknown }).location, undefined);
  } finally {
    await stub.stop();
  }
});

test('subscribe() names a generic tool_call by fact (session.tool.input.started) instead of only by input shape', async () => {
  const stub = new StubV2Server();
  const baseUrl = await stub.start();
  try {
    const adapter = createV2Adapter({ baseUrl, directory: '/tmp/x', password: 'pw' });
    const id = await adapter.createSession({ title: 't', directory: '/tmp/x', headlessPermissions: true });

    const controller = new AbortController();
    const received: CoreEvent[] = [];
    const iterate = (async () => {
      for await (const event of adapter.subscribe(id, controller.signal)) {
        received.push(event);
        if (event.type === 'tool_call' && received.length > 1) break;
      }
    })();

    setTimeout(() => {
      // An input shape with none of the known command/path fields — before
      // task 5's fix this always fell back to a raw JSON dump regardless of
      // the tool's real name.
      stub.emit(toolInputStarted(id, 'call_1', 'todowrite').data);
      stub.emit(toolCalled(id, 'call_1', { todos: [] }).data);
    }, 30);

    await iterate;
    controller.abort();

    const genericCall = received.find((event) => event.content.includes('Running todowrite'));
    assert.ok(genericCall, `expected the tool name to be threaded through, got: ${JSON.stringify(received)}`);
  } finally {
    await stub.stop();
  }
});
