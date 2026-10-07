import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteA2AAgentRepository } from '../src/repositories/sqlite-a2a-agents.js';

async function withFreshMigratedSqliteDb(run: (db: import('better-sqlite3').Database, repo: SqliteA2AAgentRepository) => Promise<void>): Promise<void> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'a2a-agent-directory-'));
  const dbPath = path.join(tempDir, 'board.db');
  const priorDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;

  try {
    const { initDatabase } = await import(`../src/db.js?a2a-agent-directory=${Date.now()}-${Math.random()}`);
    const db = initDatabase();
    try {
      await run(db, new SqliteA2AAgentRepository(db));
    } finally {
      db.close();
    }
  } finally {
    if (priorDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = priorDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('SQLite A2A agent directory persists trusted cards, local roles, and refresh failures without discarding the last good card', async () => {
  await withFreshMigratedSqliteDb(async (db, repo) => {
    db.prepare(`INSERT INTO projects (id, name, repo_path, is_default, created_at, updated_at) VALUES ('project-a', 'Project A', NULL, 0, 1, 1)`).run();
    const registered = await repo.register({
      id: 'agent-1',
      agentCardUrl: 'https://agents.example.test/.well-known/agent-card.json',
      name: 'Implementation Agent',
      description: 'Implements board tickets.',
      version: '1.0.0',
      endpoint: 'https://agents.example.test/a2a',
      protocolVersion: '1.0',
      skills: [{ id: 'implementation', name: 'Implementation', tags: ['typescript'] }],
      enabled: true,
      now: 100,
    });

    assert.deepEqual(registered, {
      id: 'agent-1',
      agentCardUrl: 'https://agents.example.test/.well-known/agent-card.json',
      name: 'Implementation Agent',
      description: 'Implements board tickets.',
      version: '1.0.0',
      endpoint: 'https://agents.example.test/a2a',
      protocolVersion: '1.0',
      skills: [{ id: 'implementation', name: 'Implementation', tags: ['typescript'] }],
      enabled: true,
      createdAt: 100,
      updatedAt: 100,
      lastValidatedAt: 100,
      projectAccess: [],
    });

    const withRole = await repo.setProjectRoles('agent-1', 'project-a', ['implementation', 'review'], 101);
    assert.deepEqual(withRole?.projectAccess, [{
      agentId: 'agent-1', projectId: 'project-a', roles: ['implementation', 'review'], createdAt: 101, updatedAt: 101,
    }]);

    const afterFailedRefresh = await repo.recordRefreshFailure('agent-1', 'Agent Card fetch failed with HTTP 503', 102);
    assert.equal(afterFailedRefresh?.name, 'Implementation Agent');
    assert.equal(afterFailedRefresh?.endpoint, 'https://agents.example.test/a2a');
    assert.equal(afterFailedRefresh?.lastValidatedAt, 100);
    assert.equal(afterFailedRefresh?.lastValidationError, 'Agent Card fetch failed with HTTP 503');
    assert.deepEqual(afterFailedRefresh?.projectAccess, [{
      agentId: 'agent-1', projectId: 'project-a', roles: ['implementation', 'review'], createdAt: 101, updatedAt: 101,
    }]);
  });
});
