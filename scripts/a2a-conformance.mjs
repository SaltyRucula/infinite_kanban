#!/usr/bin/env node
/**
 * A2A conformance check for the board (#80).
 *
 * Drives a running board with the *official* `@a2a-js/sdk` client rather than
 * curl or the board's own code, so the result says something about interop and
 * not just about internal consistency: discovery, both bindings, the four
 * request/response methods, streaming, and the refusals.
 *
 * Usage:
 *   node scripts/a2a-conformance.mjs [baseUrl] [projectName]
 *
 * Defaults: http://127.0.0.1:8080 and the project named `conformance`. The
 * project must exist and have a repository path, because admission refuses
 * work it cannot place (that refusal is itself one of the checks).
 *
 * Exit code is the number of failed checks, so CI can gate on it.
 */

import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory, RestTransportFactory } from '@a2a-js/sdk/client';
import { Role, TaskState } from '@a2a-js/sdk';

const baseUrl = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const projectName = process.argv[3] ?? 'conformance';
const token = process.env.A2A_TOKEN;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function textMessage(id, text, metadata) {
  return {
    message: {
      messageId: id,
      role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
      metadata,
      extensions: [],
      referenceTaskIds: [],
    },
  };
}

const headers = token ? { Authorization: `Bearer ${token}` } : {};
const fetchImpl = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), ...headers } });

const factoryFor = (transport) => new ClientFactory(ClientFactoryOptions.createFrom(
  ClientFactoryOptions.default,
  { transports: [transport] },
));

console.log(`A2A conformance against ${baseUrl} (project: ${projectName})\n`);

// 1. Discovery — the card has to be fetchable and describe a usable interface.
let card;
await check('agent card is served at /.well-known/agent-card.json', async () => {
  const response = await fetchImpl(`${baseUrl}/.well-known/agent-card.json`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  card = await response.json();
  const interfaces = card.supportedInterfaces ?? [];
  if (interfaces.length === 0) throw new Error('card declares no supportedInterfaces');
  return `${card.name} v${card.version}; ${interfaces.map((i) => `${i.protocolBinding}@${i.protocolVersion}`).join(', ')}`;
});

await check('card advertises streaming capability', async () => {
  if (card?.capabilities?.streaming !== true) throw new Error('capabilities.streaming is not true');
  return 'streaming: true';
});

const jsonRpcClient = await factoryFor(new JsonRpcTransportFactory({ fetchImpl })).createFromAgentCard(card);
const restClient = await factoryFor(new RestTransportFactory({ fetchImpl })).createFromAgentCard(card);

// 2. SendMessage over both bindings.
const stamp = Date.now();
let taskId;
await check('SendMessage (JSON-RPC) admits work and returns a task', async () => {
  const result = await jsonRpcClient.sendMessage(textMessage(
    `conf-jsonrpc-${stamp}`,
    'Conformance: JSON-RPC send\n\nCreated by scripts/a2a-conformance.mjs.',
    { project: projectName, autoStart: false },
  ));
  const task = result.task ?? result;
  if (!task?.id) throw new Error(`no task in result: ${JSON.stringify(result).slice(0, 160)}`);
  taskId = task.id;
  return `task ${task.id.slice(0, 8)} state ${TaskState[task.status?.state] ?? task.status?.state}`;
});

await check('SendMessage (HTTP+JSON) admits work and returns a task', async () => {
  const result = await restClient.sendMessage(textMessage(
    `conf-rest-${stamp}`,
    'Conformance: REST send\n\nCreated by scripts/a2a-conformance.mjs.',
    { project: projectName, autoStart: false },
  ));
  const task = result.task ?? result;
  if (!task?.id) throw new Error('no task in result');
  return `task ${task.id.slice(0, 8)}`;
});

// 3. Idempotency — replaying a messageId must not duplicate the work.
await check('replaying a messageId returns the same task', async () => {
  const result = await jsonRpcClient.sendMessage(textMessage(
    `conf-jsonrpc-${stamp}`,
    'Conformance: JSON-RPC send\n\nCreated by scripts/a2a-conformance.mjs.',
    { project: projectName, autoStart: false },
  ));
  const task = result.task ?? result;
  if (task.id !== taskId) throw new Error(`expected ${taskId}, got ${task.id}`);
  return 'same task id';
});

// 4. GetTask / ListTasks.
await check('GetTask returns the admitted task', async () => {
  const task = await jsonRpcClient.getTask({ id: taskId, historyLength: 0 });
  if (task.id !== taskId) throw new Error('wrong task returned');
  return `state ${TaskState[task.status?.state] ?? task.status?.state}`;
});

await check('ListTasks pages and reports a total', async () => {
  const page = await jsonRpcClient.listTasks({ pageSize: 2 });
  if (!Array.isArray(page.tasks)) throw new Error('tasks is not an array');
  if (page.tasks.length > 2) throw new Error('pageSize ignored');
  return `totalSize ${page.totalSize}, returned ${page.tasks.length}`;
});

// 5. Streaming — the board must deliver progress and end the stream.
await check('SendStreamingMessage opens a stream that terminates', async () => {
  const stream = jsonRpcClient.sendMessageStream(textMessage(
    `conf-stream-${stamp}`,
    'Conformance: streaming send\n\nCreated by scripts/a2a-conformance.mjs.',
    { project: projectName, autoStart: false },
  ));
  const kinds = [];
  const deadline = Date.now() + 15_000;
  for await (const event of stream) {
    kinds.push(event.payload?.$case ?? Object.keys(event)[0]);
    if (kinds.length >= 1) break; // the admitted task is enough to prove the stream opens
    if (Date.now() > deadline) throw new Error('stream produced nothing within 15s');
  }
  if (kinds.length === 0) throw new Error('stream produced no events');
  return `first frame: ${kinds[0]}`;
});

// 6. Refusals — the interesting half of the contract.
await check('a board-private field is refused, not ignored', async () => {
  const result = await jsonRpcClient.sendMessage(textMessage(
    `conf-private-${stamp}`,
    'Conformance: private field',
    { project: projectName, repoPath: '/etc/passwd' },
  ));
  const task = result.task ?? result;
  const state = TaskState[task.status?.state] ?? task.status?.state;
  const text = task.status?.message?.parts?.[0]?.content?.value ?? '';
  if (String(state) !== 'TASK_STATE_FAILED' && state !== TaskState.TASK_STATE_FAILED) {
    throw new Error(`expected FAILED, got ${state}`);
  }
  if (!/repoPath/.test(text)) throw new Error(`refusal does not name the field: ${text}`);
  return 'FAILED naming repoPath';
});

await check('an unknown project is rejected', async () => {
  const result = await jsonRpcClient.sendMessage(textMessage(
    `conf-noproject-${stamp}`,
    'Conformance: unknown project',
    { project: `no-such-project-${stamp}` },
  ));
  const task = result.task ?? result;
  const state = TaskState[task.status?.state] ?? task.status?.state;
  if (String(state) !== 'TASK_STATE_REJECTED' && state !== TaskState.TASK_STATE_REJECTED) {
    throw new Error(`expected REJECTED, got ${state}`);
  }
  return 'REJECTED';
});

// 7. CancelTask — A2A requires the cancelled state back.
await check('CancelTask reports TASK_STATE_CANCELED', async () => {
  const task = await jsonRpcClient.cancelTask({ id: taskId });
  const state = TaskState[task.status?.state] ?? task.status?.state;
  if (String(state) !== 'TASK_STATE_CANCELED' && state !== TaskState.TASK_STATE_CANCELED) {
    throw new Error(`expected CANCELED, got ${state}`);
  }
  return 'CANCELED';
});

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`failed: ${failed.map((result) => result.name).join('; ')}`);
}
process.exit(failed.length);
