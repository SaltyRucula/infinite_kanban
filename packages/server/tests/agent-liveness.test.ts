import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteA2AAgentRepository } from '../src/repositories/sqlite-a2a-agents.js';
import { AgentLivenessProbe, UNREACHABLE_AFTER_FAILURES } from '../src/services/agent-liveness.js';

const card = (port: number) => `http://127.0.0.1:${port}/.well-known/agent-card.json`;

/** Same pattern as a2a-agent-repository.test.ts: a real migrated database. */
async function repository() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-liveness-'));
  const prior = process.env.DB_PATH;
  process.env.DB_PATH = path.join(dir, 'board.db');
  try {
    const { initDatabase } = await import(`../src/db.js?agent-liveness=${Date.now()}-${Math.random()}`);
    const db = initDatabase();
    return {
      db: { close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } },
      repo: new SqliteA2AAgentRepository(db),
    };
  } finally {
    if (prior === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = prior;
  }
}

async function register(repo: SqliteA2AAgentRepository, id: string, port: number) {
  return repo.register({
    id, agentCardUrl: card(port), name: `endpoint ${id}`, description: '', version: '1',
    endpoint: `http://127.0.0.1:${port}/a2a/v1`, protocolVersion: '1.0',
    skills: [{ id: 'execution', name: 'Execution', description: '', tags: ['execution:v1'] }],
    enabled: true, now: 1,
  });
}

/**
 * A killed endpoint stayed enabled and kept winning routing, so the board
 * dispatched into a socket nobody was listening on. Reachability has to be
 * observed, not assumed from the fact that someone once registered.
 */
test('an endpoint that stops answering is marked unreachable, but only after repeated failures', async () => {
  const { db, repo } = await repository();
  await register(repo, 'a', 7901);
  let reachable = true;
  const probe = new AgentLivenessProbe(repo, {
    fetcher: async () => {
      if (!reachable) throw new Error('connection refused');
      return new Response(JSON.stringify({ name: 'endpoint a' }), { status: 200 });
    },
    now: () => 1000,
  });

  await probe.sweep();
  assert.equal((await repo.getById('a'))?.unreachableSince, undefined, 'a healthy endpoint stays reachable');

  reachable = false;
  for (let attempt = 1; attempt < UNREACHABLE_AFTER_FAILURES; attempt += 1) {
    await probe.sweep();
    assert.equal((await repo.getById('a'))?.unreachableSince, undefined, `a single blip must not strand routing (attempt ${attempt})`);
  }
  await probe.sweep();
  const down = await repo.getById('a');
  assert.equal(down?.unreachableSince, 1000);
  assert.match(down?.lastValidationError ?? '', /connection refused/);
  assert.equal(down?.enabled, true, 'liveness is observed, not an operator decision to disable');
  db.close();
});

test('an endpoint that comes back is reachable again, with the failure cleared', async () => {
  const { db, repo } = await repository();
  await register(repo, 'a', 7901);
  let reachable = false;
  const probe = new AgentLivenessProbe(repo, {
    fetcher: async () => {
      if (!reachable) throw new Error('connection refused');
      return new Response('{}', { status: 200 });
    },
    now: () => 2000,
  });
  for (let i = 0; i < UNREACHABLE_AFTER_FAILURES; i += 1) await probe.sweep();
  assert.equal((await repo.getById('a'))?.unreachableSince, 2000);

  reachable = true;
  await probe.sweep();
  const back = await repo.getById('a');
  assert.equal(back?.unreachableSince, undefined);
  assert.equal(back?.lastValidationError, undefined);
  assert.equal(back?.lastValidatedAt, 2000);
  db.close();
});

test('a non-200 answer counts as a failure, and a disabled endpoint is not probed', async () => {
  const { db, repo } = await repository();
  await register(repo, 'a', 7901);
  await register(repo, 'b', 7902);
  await repo.setEnabled('b', false, 1);
  const probed: string[] = [];
  const probe = new AgentLivenessProbe(repo, {
    fetcher: async (url) => { probed.push(url); return new Response('nope', { status: 503 }); },
    now: () => 3000,
  });
  for (let i = 0; i < UNREACHABLE_AFTER_FAILURES; i += 1) await probe.sweep();
  assert.equal((await repo.getById('a'))?.unreachableSince, 3000);
  assert.ok(probed.every((url) => url.includes('7901')), 'a disabled endpoint must not be probed');
  db.close();
});

test('the sweep survives one endpoint hanging or throwing', async () => {
  const { db, repo } = await repository();
  await register(repo, 'slow', 7901);
  await register(repo, 'fine', 7902);
  const probe = new AgentLivenessProbe(repo, {
    fetcher: async (url) => {
      if (url.includes('7901')) throw new Error('boom');
      return new Response('{}', { status: 200 });
    },
    now: () => 4000,
  });
  await assert.doesNotReject(() => probe.sweep());
  assert.equal((await repo.getById('fine'))?.lastValidatedAt, 4000);
  db.close();
});
