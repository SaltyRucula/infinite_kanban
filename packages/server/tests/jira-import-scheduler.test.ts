import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project } from '../src/types.js';
import { JiraImportScheduler, isProjectDueForJiraImport } from '../src/jira/import-scheduler.js';
import type { JiraImportExecutor } from '../src/jira/import-execution.js';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project 1',
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    jiraImportEnabled: true,
    jiraImportIntervalMinutes: 15,
    ...overrides,
  };
}

test('isProjectDueForJiraImport respects disabled projects and due intervals', () => {
  const now = 1_000_000;

  assert.equal(isProjectDueForJiraImport(makeProject({ jiraImportEnabled: false }), now), false);
  assert.equal(isProjectDueForJiraImport(makeProject({ jiraImportLastRunAt: undefined, updatedAt: now }), now), true);
  assert.equal(isProjectDueForJiraImport(makeProject({ jiraImportLastRunAt: undefined, updatedAt: now - (15 * 60_000) }), now), true);
  assert.equal(isProjectDueForJiraImport(makeProject({ jiraImportLastRunAt: now - 10_000 }), now), false);
  assert.equal(
    isProjectDueForJiraImport(makeProject({ jiraImportLastRunAt: now - (15 * 60_000) }), now),
    true,
  );
});

test('isProjectDueForJiraImport uses a five-minute interval only while the board has no active agent', () => {
  const now = 1_000_000;
  const project = makeProject({ jiraImportLastRunAt: now - (5 * 60_000) });

  assert.equal(isProjectDueForJiraImport(project, now, true), true);
  assert.equal(isProjectDueForJiraImport(project, now, false), false);
});

test('isProjectDueForJiraImport treats legacy projects with missing enabled flag as disabled', () => {
  const now = 1_000_000;
  assert.equal(
    isProjectDueForJiraImport(makeProject({ jiraImportEnabled: undefined, jiraImportLastRunAt: undefined }), now),
    false,
  );
  assert.equal(
    isProjectDueForJiraImport(makeProject({ jiraImportEnabled: true, jiraImportLastRunAt: undefined }), now),
    true,
  );
});

test('JiraImportScheduler imports only enabled due projects and allows project-level concurrency', async () => {
  const projects = [
    makeProject({ id: 'p-due-a', name: 'A', jiraImportEnabled: true, jiraImportLastRunAt: undefined }),
    makeProject({ id: 'p-due-b', name: 'B', jiraImportEnabled: true, jiraImportLastRunAt: undefined }),
    makeProject({ id: 'p-disabled', name: 'C', jiraImportEnabled: false, jiraImportLastRunAt: undefined }),
    makeProject({ id: 'p-not-due', name: 'D', jiraImportEnabled: true, jiraImportLastRunAt: Date.now() }),
  ];

  const started: string[] = [];
  let maxInFlight = 0;
  let inFlight = 0;

  const importExecutor: JiraImportExecutor = {
    async executeProjectImport(project): Promise<{ status: 'completed'; result: { total: number; created: number; skipped: number; tasks: [] } }> {
      started.push(project.id);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      inFlight -= 1;
      return { status: 'completed', result: { total: 0, created: 0, skipped: 0, tasks: [] } };
    },
    async awaitIdle(): Promise<boolean> {
      return true;
    },
  };

  const scheduler = new JiraImportScheduler({
    projectRepo: {
      async getAllWithCounts(): Promise<Project[]> {
        return projects;
      },
    },
    importExecutor,
    tickMs: 5,
    now: () => 2_000_000,
  });

  scheduler.start();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 15);
  });
  scheduler.stop();
  await scheduler.awaitIdle(1_000);

  assert.deepEqual(started.sort(), ['p-due-a', 'p-due-b']);
  assert.ok(maxInFlight >= 2);
});

test('JiraImportScheduler stop prevents new ticks and awaitIdle waits for executor', async () => {
  let runs = 0;
  let active = false;
  let now = 10_000;

  const importExecutor: JiraImportExecutor = {
    async executeProjectImport(): Promise<{ status: 'completed'; result: { total: number; created: number; skipped: number; tasks: [] } }> {
      runs += 1;
      active = true;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 60);
      });
      active = false;
      return { status: 'completed', result: { total: 0, created: 0, skipped: 0, tasks: [] } };
    },
    async awaitIdle(timeoutMs): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (active) {
        if (Date.now() >= deadline) return false;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      return true;
    },
  };

  const scheduler = new JiraImportScheduler({
    projectRepo: {
      async getAllWithCounts(): Promise<Project[]> {
        return [makeProject({ jiraImportLastRunAt: now - (20 * 60_000) })];
      },
    },
    importExecutor,
    tickMs: 15,
    now: () => now,
  });

  scheduler.start();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });
  scheduler.stop();

  const drained = await scheduler.awaitIdle(2_000);
  const runCountAfterStop = runs;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 40);
  });

  assert.equal(drained, true);
  assert.equal(runs, runCountAfterStop);
});

test('JiraImportScheduler requestTick queues exactly one follow-up tick while a tick is in progress', async () => {
  const projects = [makeProject({ id: 'p-due', jiraImportLastRunAt: undefined })];
  let listCalls = 0;
  let runCount = 0;

  const importExecutor: JiraImportExecutor = {
    async executeProjectImport(): Promise<{ status: 'completed'; result: { total: number; created: number; skipped: number; tasks: [] } }> {
      runCount += 1;
      if (runCount === 1) {
        scheduler.requestTick();
      }
      return { status: 'completed', result: { total: 0, created: 0, skipped: 0, tasks: [] } };
    },
    async awaitIdle(): Promise<boolean> {
      return true;
    },
  };

  const scheduler = new JiraImportScheduler({
    projectRepo: {
      async getAllWithCounts(): Promise<Project[]> {
        listCalls += 1;
        return projects;
      },
    },
    importExecutor,
    tickMs: 50_000,
    now: () => 10_000_000,
  });

  scheduler.start();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 30);
  });
  scheduler.stop();
  await scheduler.awaitIdle(500);

  assert.equal(runCount, 2);
  assert.equal(listCalls, 2);
});
