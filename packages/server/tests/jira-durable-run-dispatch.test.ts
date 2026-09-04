import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Task } from '../src/types.js';
import type { JiraIssue } from '../src/jira/client.js';
import { JiraImportExecutionService } from '../src/jira/import-execution.js';
import { createDurableRunRequestedCallback, dispatchPendingRuns } from '../src/run-dispatcher.js';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project 1',
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    jiraImportEnabled: true,
    jiraImportIntervalMinutes: 15,
    jiraImportAutoStart: true,
    repoPath: process.cwd(),
    defaultAgentType: 'copilot',
    ...overrides,
  };
}

function makeIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '10001',
    key: 'PROJ-1',
    summary: 'Imported issue',
    description: 'desc',
    status: 'To Do',
    issueType: 'Task',
    ...overrides,
  };
}

test('Jira durable callback dispatches pending runs (startAgentForTask-equivalent) in addition to scheduler tick', async () => {
  const project = makeProject();
  const byIdentity = new Map<string, Task>();
  const requestRunCalls: string[] = [];
  const dispatchedTaskIds: string[] = [];
  const callbackSteps: string[] = [];
  const runningTaskIds = new Set<string>();
  let schedulerTickCalls = 0;

  const taskRepo = {
    async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
      const key = `${task.externalSource ?? ''}:${task.externalKey ?? ''}`;
      const existing = byIdentity.get(key);
      if (existing) return { task: existing, created: false };
      byIdentity.set(key, task);
      return { task, created: true };
    },
    async requestRun(id: string): Promise<Task | undefined> {
      requestRunCalls.push(id);
      const task = [...byIdentity.values()].find((candidate) => candidate.id === id);
      if (!task) return undefined;
      const updated = { ...task, runRequestedAt: Date.now() };
      byIdentity.set(`${updated.externalSource ?? ''}:${updated.externalKey ?? ''}`, updated);
      return updated;
    },
    async insertEvent(): Promise<void> {},
    async getPendingRuns(): Promise<Task[]> {
      return [...byIdentity.values()].filter((candidate) => typeof candidate.runRequestedAt === 'number');
    },
  };

  const onDurableRunRequested = createDurableRunRequestedCallback({
    dispatchPendingRuns: async () => {
      await dispatchPendingRuns({
        taskRepo,
        isTaskRunning: (taskId) => runningTaskIds.has(taskId),
        dispatchTask: async (task) => {
          callbackSteps.push(`dispatch:${task.id}`);
          runningTaskIds.add(task.id);
          dispatchedTaskIds.push(task.id);
        },
      });
    },
    requestSchedulerTick: () => {
      callbackSteps.push('tick');
      schedulerTickCalls += 1;
    },
  });

  const service = new JiraImportExecutionService({
    taskRepo,
    projectRepo: {
      async update(): Promise<Project | undefined> {
        return project;
      },
    },
    configResolver: () => ({
      configured: true,
      config: {
        baseUrl: 'https://jira.example.com',
        normalizedBaseUrl: 'https://jira.example.com',
        userEmail: 'user@example.com',
        apiToken: 'token',
        isDataCenter: false,
      },
    }),
    clientFactory: () => ({
      async listAssignedIssues(): Promise<readonly JiraIssue[]> {
        return [makeIssue(), makeIssue({ summary: 'duplicate' })];
      },
    }),
    listAvailableAgents: () => [{
      name: 'copilot',
      displayName: 'Copilot',
      available: true,
    }],
    repoPathValidator: () => ({ valid: true }),
    onDurableRunRequested,
  });

  const outcome = await service.executeProjectImport(project, 'manual');
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;

  assert.equal(outcome.result.created, 1);
  assert.equal(requestRunCalls.length, 1);
  assert.deepEqual(dispatchedTaskIds, requestRunCalls);
  assert.equal(schedulerTickCalls, 1);
  assert.match(callbackSteps[0] ?? '', /^dispatch:/);
  assert.equal(callbackSteps[1], 'tick');
});
