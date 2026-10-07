import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import type { A2AAgent } from '../src/types.js';
import { createA2AAgentsRouter } from '../src/routes/a2a-agents.js';

function agent(): A2AAgent {
  return {
    id: 'agent-1', agentCardUrl: 'https://agents.example.test/.well-known/agent-card.json',
    name: 'Implementation Agent', description: 'Implements tickets.', version: '1.0.0',
    endpoint: 'https://agents.example.test/a2a', protocolVersion: '1.0', skills: [], enabled: true,
    createdAt: 1, updatedAt: 1, lastValidatedAt: 1, projectAccess: [],
  };
}

async function withServer(app: express.Express, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`); } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('A2A directory routes validate cards before registration, retain cards after refresh failure, and enforce local project roles', async () => {
  let current = agent();
  const calls: string[] = [];
  const repo = {
    getAll: async () => [current],
    getById: async (id: string) => id === current.id ? current : undefined,
    register: async (input: any) => { calls.push('register'); current = { ...current, ...input, createdAt: input.now, updatedAt: input.now, lastValidatedAt: input.now, projectAccess: [] }; return current; },
    setEnabled: async (_id: string, enabled: boolean, now: number) => { calls.push('enabled'); current = { ...current, enabled, updatedAt: now }; return current; },
    setProjectRoles: async (_id: string, projectId: string, roles: any[], now: number) => { calls.push('roles'); current = { ...current, projectAccess: [{ agentId: current.id, projectId, roles, createdAt: now, updatedAt: now }] }; return current; },
    recordRefreshFailure: async (_id: string, error: string, now: number) => { calls.push('failed-refresh'); current = { ...current, updatedAt: now, lastValidationError: error }; return current; },
    refresh: async () => { throw new Error('unexpected successful refresh'); },
    delete: async () => true,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/a2a-agents', createA2AAgentsRouter(repo, {
    fetchCard: async () => ({ name: 'Review Agent', description: 'Reviews tickets.', version: '1.0.0', endpoint: 'https://agents.example.test/a2a', protocolVersion: '1.0', skills: [] }),
    projectExists: async (id: string) => id === 'project-a',
  }));

  let directoryId = 'agent-1';
  await withServer(app, async (url) => {
    const registered = await fetch(`${url}/api/a2a-agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentCardUrl: current.agentCardUrl }) });
    assert.equal(registered.status, 201);
    const registeredBody = await registered.json();
    assert.equal(registeredBody.name, 'Review Agent');
    directoryId = registeredBody.id;

    const roles = await fetch(`${url}/api/a2a-agents/${directoryId}/projects/project-a/roles`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roles: ['implementation', 'review'] }) });
    assert.equal(roles.status, 200);
    assert.deepEqual((await roles.json()).projectAccess[0].roles, ['implementation', 'review']);

    const invalidProject = await fetch(`${url}/api/a2a-agents/${directoryId}/projects/missing/roles`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roles: ['review'] }) });
    assert.equal(invalidProject.status, 404);

    const failingApp = express();
    failingApp.use(express.json());
    failingApp.use('/api/a2a-agents', createA2AAgentsRouter(repo, { fetchCard: async () => { throw new Error('Agent Card fetch failed with HTTP 503'); }, projectExists: async () => true }));
    await withServer(failingApp, async (failingUrl) => {
      const refreshed = await fetch(`${failingUrl}/api/a2a-agents/${directoryId}/refresh`, { method: 'POST' });
      assert.equal(refreshed.status, 502);
      const body = await refreshed.json();
      assert.equal(body.agent.name, 'Review Agent');
      assert.equal(body.agent.lastValidationError, 'Agent Card fetch failed with HTTP 503');
    });
  });

  assert.deepEqual(calls, ['register', 'roles', 'failed-refresh']);
});
