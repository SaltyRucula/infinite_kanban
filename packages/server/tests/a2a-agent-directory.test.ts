import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchA2AAgentCard } from '../src/services/a2a-agent-directory.js';

test('fetches and normalizes a trusted Agent Card URL', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const card = await fetchA2AAgentCard(
    'https://agents.example.test/.well-known/agent-card.json',
    async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        name: 'Review Agent',
        description: 'Reviews board ticket artifacts.',
        version: '1.0.0',
        capabilities: {},
        supportedInterfaces: [{
          url: 'https://agents.example.test/a2a',
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  );

  assert.deepEqual(card, {
    name: 'Review Agent',
    description: 'Reviews board ticket artifacts.',
    version: '1.0.0',
    endpoint: 'https://agents.example.test/a2a',
    protocolVersion: '1.0',
    skills: [],
  });
  assert.deepEqual(calls, [{
    url: 'https://agents.example.test/.well-known/agent-card.json',
    init: { headers: { accept: 'application/json' } },
  }]);
});

test('permits an HTTP Agent Card URL only on loopback for local-first deployments', async () => {
  const card = await fetchA2AAgentCard(
    'http://127.0.0.1:4123/.well-known/agent-card.json',
    async () => new Response(JSON.stringify({
      name: 'Local Agent',
      description: 'Runs on the same machine.',
      version: '1.0.0',
      capabilities: {},
      supportedInterfaces: [{
        url: 'http://127.0.0.1:4123/a2a',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      }],
    }), { status: 200 }),
  );

  assert.equal(card.endpoint, 'http://127.0.0.1:4123/a2a');
});

test('rejects a trusted Agent Card URL when the fetch response is not successful', async () => {
  await assert.rejects(
    () => fetchA2AAgentCard(
      'https://agents.example.test/.well-known/agent-card.json',
      async () => new Response('not found', { status: 404 }),
    ),
    /failed with HTTP 404/,
  );
});
