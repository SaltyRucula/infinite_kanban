import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteTaskGroupRepository } from '../src/repositories/sqlite-groups.js';
import type { Task, TaskGroup } from '../src/types.js';

async function withFreshMigratedSqliteDb(
  run: (repo: SqliteTaskGroupRepository) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'group-dependency-persistence-'));
  const priorDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(tempDir, 'board.db');

  try {
    const { initDatabase } = await import(`../src/db.js?group-dependencies=${Date.now()}-${Math.random()}`);
    const db = initDatabase();
    try {
      await run(new SqliteTaskGroupRepository(db));
    } finally {
      db.close();
    }
  } finally {
    if (priorDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = priorDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function makeGroup(): TaskGroup {
  return {
    id: 'group-1',
    projectId: 'default',
    title: 'Ordered deployment',
    priority: 'high',
    columnId: 'backlog',
    maxConcurrency: 2,
    createdAt: 1,
  };
}

function makeChild(id: string, dependsOn?: string[]): Omit<Task, 'columnId' | 'agentStatus' | 'createdAt'> {
  return {
    id,
    projectId: 'default',
    title: id,
    description: '',
    priority: 'high',
    groupId: 'group-1',
    groupOrder: id === 'infra' ? 0 : 1,
    labels: [],
    ...(dependsOn === undefined ? {} : { dependsOn }),
  };
}

test('SQLite group repository persists child dependencies for a later queue run', async () => {
  await withFreshMigratedSqliteDb(async (repo) => {
    await repo.create(makeGroup(), [
      makeChild('infra'),
      makeChild('application', ['infra']),
    ]);

    const children = await repo.getChildTasks('group-1');
    assert.deepEqual(children.map(({ id, dependsOn }) => ({ id, dependsOn })), [
      { id: 'infra', dependsOn: undefined },
      { id: 'application', dependsOn: ['infra'] },
    ]);
  });
});
