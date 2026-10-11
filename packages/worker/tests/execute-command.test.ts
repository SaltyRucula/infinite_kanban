import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { executionEndpointConfig, connectExecutionEndpoint } from '../src/execute-command.js';

const base = {
  role: 'implementation',
  harness: 'opencode',
  project: 'p1',
  repo: 'https://github.com/o/r=/tmp/checkout',
};

test('flags become an endpoint configuration with the harness owned locally', async () => {
  const config = executionEndpointConfig({
    ...base,
    model: 'github-copilot/gpt-6.1-sol',
    capability: 'git:revision,build:node',
    check: 'tests=npm run test',
    'state-dir': '/tmp/endpoint-state',
  });

  assert.deepEqual(config.roles, ['implementation']);
  assert.equal(config.harness, 'opencode');
  assert.equal(config.model, 'github-copilot/gpt-6.1-sol');
  assert.deepEqual(config.projects, ['p1']);
  assert.deepEqual(config.repositories, { 'https://github.com/o/r': '/tmp/checkout' });
  assert.deepEqual(config.capabilities, ['git:revision', 'build:node']);
  assert.deepEqual(config.checks, [{ name: 'tests', command: 'npm', args: ['run', 'test'] }]);
  assert.equal(config.stateDirectory, '/tmp/endpoint-state');
});

test('one endpoint can hold both roles, and its card advertises each of them', async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'endpoint-cli-'));
  const config = executionEndpointConfig({ ...base, role: 'implementation,review' });
  assert.deepEqual(config.roles, ['implementation', 'review']);
  // The default identity directory must not collide with a single-role endpoint's.
  assert.match(executionEndpointConfig({ ...base, role: 'review,implementation' }).stateDirectory, /implementation-review$/);

  const calls: { url: string; body: unknown }[] = [];
  const board = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      calls.push({ url: request.url ?? '', body: raw ? JSON.parse(raw) : undefined });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'agent-both' }));
    });
  });
  await new Promise<void>((resolve) => board.listen(0, '127.0.0.1', resolve));
  const connection = await connectExecutionEndpoint({
    ...base,
    role: 'implementation,review',
    board: `http://127.0.0.1:${(board.address() as AddressInfo).port}`,
    'state-dir': stateDirectory,
    port: '0',
  });
  try {
    // Both roles are granted in one request, so the board can pick either.
    assert.deepEqual(calls.at(-1)?.body, { roles: ['implementation', 'review'] });
    const card = await (await fetch(`${connection.baseUrl}/.well-known/agent-card.json`)).json();
    assert.deepEqual(card.skills.map((skill: { id: string }) => skill.id), ['implementation', 'review']);
    const review = card.skills.find((skill: { id: string }) => skill.id === 'review');
    // Only the review skill may claim the read-only snapshot capability.
    assert.ok(review.tags.includes('review:snapshot'));
    assert.ok(!card.skills.find((skill: { id: string }) => skill.id === 'implementation').tags.includes('review:snapshot'));
  } finally {
    await connection.close();
    await new Promise<void>((resolve) => board.close(() => resolve()));
  }
});

test('several projects and repositories are accepted, and capabilities default to git:revision', () => {
  const config = executionEndpointConfig({
    ...base,
    project: 'p1,p2',
    repo: 'https://github.com/o/r=/tmp/one,https://github.com/o/other=/tmp/two',
  });

  assert.deepEqual(config.projects, ['p1', 'p2']);
  assert.deepEqual(config.repositories, {
    'https://github.com/o/r': '/tmp/one',
    'https://github.com/o/other': '/tmp/two',
  });
  assert.deepEqual(config.capabilities, ['git:revision']);
  assert.deepEqual(config.checks, []);
});

test('unusable configurations are refused before anything starts', () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ ...base, role: '' }, /--role/],
    [{ ...base, role: 'reviewer' }, /implementation.*review/],
    [{ ...base, role: 'implementation,reviewer' }, /implementation.*review/],
    [{ ...base, role: 'implementation,implementation' }, /once/],
    [{ ...base, harness: 'claude' }, /opencode.*codex/],
    [{ ...base, project: '' }, /--project/],
    [{ ...base, repo: '' }, /--repo/],
    // A bare path cannot be matched against the portable identity on the wire.
    [{ ...base, repo: '/tmp/checkout' }, /identity=\/local\/path/],
    [{ ...base, check: 'broken' }, /--check/],
  ];
  for (const [args, expected] of cases) {
    assert.throws(() => executionEndpointConfig(args), expected, JSON.stringify(args));
  }
});

test('connect registers its own agent card with the board and grants the role', async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'endpoint-cli-'));
  const calls: { method: string; url: string; body: unknown; authorization?: string }[] = [];
  const board = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      calls.push({
        method: request.method ?? '',
        url: request.url ?? '',
        body: raw ? JSON.parse(raw) : undefined,
        authorization: request.headers.authorization,
      });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'agent-1' }));
    });
  });
  await new Promise<void>((resolve) => board.listen(0, '127.0.0.1', resolve));
  const boardUrl = `http://127.0.0.1:${(board.address() as AddressInfo).port}`;

  const connection = await connectExecutionEndpoint({
    ...base,
    board: boardUrl,
    'api-key': 'board-secret',
    'state-dir': stateDirectory,
    port: '0',
  });
  try {
    assert.equal(connection.agentId, 'agent-1');

    const [registration, grant] = calls;
    assert.equal(registration.method, 'POST');
    assert.equal(registration.url, '/api/a2a-agents');
    // The board is told where to fetch the card, never the harness or local paths.
    assert.deepEqual(registration.body, { agentCardUrl: `${connection.baseUrl}/.well-known/agent-card.json` });
    assert.equal(registration.authorization, 'Bearer board-secret');

    assert.equal(grant.method, 'PUT');
    assert.equal(grant.url, '/api/a2a-agents/agent-1/projects/p1/roles');
    assert.deepEqual(grant.body, { roles: ['implementation'] });

    // The card the board will fetch has to advertise the role it was granted.
    const card = await (await fetch(`${connection.baseUrl}/.well-known/agent-card.json`)).json();
    assert.deepEqual(card.skills.map((skill: { id: string }) => skill.id), ['implementation']);
    assert.ok(card.skills[0].tags.includes('execution:v1'));
    assert.ok(card.skills[0].tags.includes('consent:p1'));
  } finally {
    await connection.close();
    await new Promise<void>((resolve) => board.close(() => resolve()));
  }
});

test('a board that refuses the registration surfaces the board error, not a silent endpoint', async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'endpoint-cli-'));
  const board = createServer((_request, response) => {
    response.statusCode = 403;
    response.end(JSON.stringify({ error: 'insufficient scope' }));
  });
  await new Promise<void>((resolve) => board.listen(0, '127.0.0.1', resolve));
  const boardUrl = `http://127.0.0.1:${(board.address() as AddressInfo).port}`;
  try {
    await assert.rejects(
      connectExecutionEndpoint({ ...base, board: boardUrl, 'state-dir': stateDirectory, port: '0' }),
      /insufficient scope/,
    );
  } finally {
    await new Promise<void>((resolve) => board.close(() => resolve()));
  }
});
