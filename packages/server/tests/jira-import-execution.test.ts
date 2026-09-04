import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent, Project, Task } from '../src/types.js';
import type { JiraIssue } from '../src/jira/client.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
import {
  JiraImportConflictError,
  JiraImportExecutionService,
  JiraImportNotConfiguredError,
  type JiraImportExecutionDependencies,
} from '../src/jira/import-execution.js';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project 1',
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    jiraImportEnabled: true,
    jiraImportIntervalMinutes: 15,
    jiraImportAutoStart: false,
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

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('JiraImportExecutionService persists success metadata and broadcasts created tasks', async () => {
  const project = makeProject();
  const updates: Array<Record<string, unknown>> = [];
  const byIdentity = new Map<string, Task>();
  const broadcasts: Task[] = [];
  let now = 1_000;

  const deps: JiraImportExecutionDependencies = {
    taskRepo: {
      async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
        const key = `${task.externalSource ?? ''}:${task.externalKey ?? ''}`;
        const existing = byIdentity.get(key);
        if (existing) return { task: existing, created: false };
        byIdentity.set(key, task);
        return { task, created: true };
      },
      async requestRun(id: string): Promise<Task | undefined> {
        return [...byIdentity.values()].find((candidate) => candidate.id === id);
      },
      async insertEvent(): Promise<void> {},
    },
    projectRepo: {
      async update(_id, update): Promise<Project | undefined> {
        updates.push(update as unknown as Record<string, unknown>);
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
    broadcaster: (task) => {
      broadcasts.push(task);
    },
    now: () => {
      now += 100;
      return now;
    },
  };

  const service = new JiraImportExecutionService(deps);
  const outcome = await service.executeProjectImport(project, 'manual');

  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;
  assert.deepEqual(
    {
      total: outcome.result.total,
      created: outcome.result.created,
      skipped: outcome.result.skipped,
      tasks: outcome.result.tasks.length,
    },
    { total: 2, created: 1, skipped: 1, tasks: 1 },
  );

  assert.equal(broadcasts.length, 1);
  assert.equal(updates.length, 2);
  assert.equal(typeof updates[0].jiraImportLastRunAt, 'number');
  assert.equal(typeof updates[1].jiraImportLastCompletedAt, 'number');
  assert.equal(typeof updates[1].jiraImportLastSuccessAt, 'number');
  assert.equal(updates[1].jiraImportLastError, null);
  assert.equal(updates[1].jiraImportLastTotal, 2);
  assert.equal(updates[1].jiraImportLastCreated, 1);
  assert.equal(updates[1].jiraImportLastSkipped, 1);
});

test('JiraImportExecutionService routes an unlabeled scheduled issue and leaves triage empty', async () => {
  const tellurium = makeProject({ id: 'tellurium', aliases: ['intvis.tellurium'], jiraImportAutoStart: false });
  const infrastructure = makeProject({ id: 'infrastructure', aliases: ['intvis.infrastructure'], jiraImportAutoStart: false });
  const triage = makeProject({ id: 'triage', aliases: ['jira:triage'], repoPath: undefined, jiraImportAutoStart: false });
  const issue = makeIssue({ id: 'unlabeled-1', labels: undefined, components: undefined });
  const created: Task[] = [];

  const service = new JiraImportExecutionService({
    taskRepo: {
      async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
        created.push(task);
        return { task, created: true };
      },
      async requestRun(): Promise<Task | undefined> { return undefined; },
      async insertEvent(): Promise<void> {},
    },
    projectRepo: { async update(): Promise<Project | undefined> { return tellurium; } },
    listRoutingProjects: async () => [tellurium, infrastructure, triage],
    repositoryRouter: { async route(): Promise<string | null> { return tellurium.id; } },
    configResolver: () => ({
      configured: true,
      config: {
        baseUrl: 'https://jira.example.com', normalizedBaseUrl: 'https://jira.example.com',
        userEmail: 'user@example.com', apiToken: 'token', isDataCenter: false,
      },
    }),
    clientFactory: () => ({ async listAssignedIssues(): Promise<readonly JiraIssue[]> { return [issue]; } }),
  });

  const routed = await service.executeProjectImport(tellurium, 'scheduled');
  const triaged = await service.executeProjectImport(triage, 'scheduled');
  assert.equal(routed.status, 'completed');
  assert.equal(triaged.status, 'completed');
  if (routed.status !== 'completed' || triaged.status !== 'completed') return;
  assert.equal(routed.result.created, 1);
  assert.equal(triaged.result.created, 0);
  assert.equal(created[0]?.projectId, tellurium.id);
});

test('JiraImportExecutionService requests durable runs once for newly created imports when auto-start is enabled and project has a usable repo/default agent', async () => {
  const project = makeProject({ jiraImportAutoStart: true });
  const byIdentity = new Map<string, Task>();
  const persistedEvents: string[] = [];
  const requestRunCalls: string[] = [];
  const callOrder: string[] = [];
  let now = 20_000;

  const service = new JiraImportExecutionService({
    taskRepo: {
      async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
        const key = `${task.externalSource ?? ''}:${task.externalKey ?? ''}`;
        const existing = byIdentity.get(key);
        if (existing) return { task: existing, created: false };
        byIdentity.set(key, task);
        return { task, created: true };
      },
      async requestRun(id: string): Promise<Task | undefined> {
        requestRunCalls.push(id);
        callOrder.push(`requestRun:${id}`);
        const task = [...byIdentity.values()].find((candidate) => candidate.id === id);
        if (!task) return undefined;
        assert.equal(task.columnId, 'backlog');
        const updated = { ...task, runRequestedAt: now };
        byIdentity.set(`${updated.externalSource ?? ''}:${updated.externalKey ?? ''}`, updated);
        return updated;
      },
      async insertEvent(event: AgentEvent): Promise<void> {
        persistedEvents.push(event.content);
      },
    },
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
    broadcaster: (task) => {
      assert.equal(task.columnId, 'backlog');
      callOrder.push(`broadcast:${task.id}`);
    },
    onDurableRunRequested: () => {
      callOrder.push('dispatch');
    },
    listAvailableAgents: () => [{
      name: 'copilot',
      displayName: 'Copilot',
      available: true,
    }],
    repoPathValidator: () => ({
      valid: true,
    }),
    now: () => {
      now += 100;
      return now;
    },
  });

  const outcome = await service.executeProjectImport(project, 'manual');
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;

  assert.equal(outcome.result.created, 1);
  assert.equal(requestRunCalls.length, 1);
  assert.equal(persistedEvents.length, 0);
  assert.equal(callOrder.length, 3);
  assert.match(callOrder[0], /^broadcast:/);
  assert.match(callOrder[1], /^requestRun:/);
  assert.equal(callOrder[2], 'dispatch');
});

test('JiraImportExecutionService skips Jira auto-start and emits error event when repoPath is missing', async () => {
  const project = makeProject({ jiraImportAutoStart: true, repoPath: undefined });
  const persistedEvents: Array<{ readonly taskId: string; readonly content: string }> = [];
  const broadcastEvents: string[] = [];
  const requestRunCalls: string[] = [];
  let dispatchCalls = 0;

  const service = new JiraImportExecutionService({
    taskRepo: {
      async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
        return { task, created: true };
      },
      async requestRun(id: string): Promise<Task | undefined> {
        requestRunCalls.push(id);
        return undefined;
      },
      async insertEvent(event: AgentEvent): Promise<void> {
        persistedEvents.push({ taskId: event.taskId, content: event.content });
      },
    },
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
        return [makeIssue({ id: 'missing-repo-1', key: 'PROJ-MISSING-REPO' })];
      },
    }),
    onDurableRunRequested: () => {
      dispatchCalls += 1;
    },
    listAvailableAgents: () => [{
      name: 'copilot',
      displayName: 'Copilot',
      available: true,
    }],
    eventBroadcaster: (event) => {
      broadcastEvents.push(event.content);
    },
  });

  const outcome = await service.executeProjectImport(project, 'scheduled');
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;

  assert.equal(outcome.result.created, 1);
  assert.equal(requestRunCalls.length, 0);
  assert.equal(dispatchCalls, 0);
  assert.equal(outcome.result.tasks[0]?.columnId, 'backlog');
  assert.equal(outcome.result.tasks[0]?.runRequestedAt, undefined);
  assert.equal(persistedEvents.length, 1);
  assert.equal(broadcastEvents.length, 1);
  assert.match(persistedEvents[0]?.content ?? '', /repoPath is missing/i);
});

test('JiraImportExecutionService skips Jira auto-start and emits error event when repoPath is invalid', async () => {
  const project = makeProject({ jiraImportAutoStart: true, repoPath: '/tmp/not-a-valid-repo' });
  const persistedEvents: Array<{ readonly taskId: string; readonly content: string }> = [];
  const requestRunCalls: string[] = [];
  let dispatchCalls = 0;

  const service = new JiraImportExecutionService({
    taskRepo: {
      async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
        return { task, created: true };
      },
      async requestRun(id: string): Promise<Task | undefined> {
        requestRunCalls.push(id);
        return undefined;
      },
      async insertEvent(event: AgentEvent): Promise<void> {
        persistedEvents.push({ taskId: event.taskId, content: event.content });
      },
    },
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
        return [makeIssue({ id: 'invalid-repo-1', key: 'PROJ-INVALID-REPO' })];
      },
    }),
    onDurableRunRequested: () => {
      dispatchCalls += 1;
    },
    listAvailableAgents: () => [{
      name: 'copilot',
      displayName: 'Copilot',
      available: true,
    }],
    repoPathValidator: () => ({
      valid: false,
      error: 'repoPath does not exist: /tmp/not-a-valid-repo',
    }),
  });

  const outcome = await service.executeProjectImport(project, 'scheduled');
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;

  assert.equal(outcome.result.created, 1);
  assert.equal(requestRunCalls.length, 0);
  assert.equal(dispatchCalls, 0);
  assert.equal(outcome.result.tasks[0]?.columnId, 'backlog');
  assert.equal(outcome.result.tasks[0]?.runRequestedAt, undefined);
  assert.equal(persistedEvents.length, 1);
  assert.match(persistedEvents[0]?.content ?? '', /repoPath is not usable/i);
});

test('JiraImportExecutionService skips Jira auto-start and emits error event when default agent is unavailable', async () => {
  const project = makeProject({ jiraImportAutoStart: true, defaultAgentType: 'opencode' });
  const persistedEvents: Array<{ readonly taskId: string; readonly content: string }> = [];
  const requestRunCalls: string[] = [];
  let dispatchCalls = 0;

  const service = new JiraImportExecutionService({
    taskRepo: {
      async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
        return { task, created: true };
      },
      async requestRun(id: string): Promise<Task | undefined> {
        requestRunCalls.push(id);
        return undefined;
      },
      async insertEvent(event: AgentEvent): Promise<void> {
        persistedEvents.push({ taskId: event.taskId, content: event.content });
      },
    },
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
        return [makeIssue({ id: 'missing-agent-1', key: 'PROJ-MISSING-AGENT' })];
      },
    }),
    onDurableRunRequested: () => {
      dispatchCalls += 1;
    },
    repoPathValidator: () => ({ valid: true }),
    listAvailableAgents: () => [{
      name: 'opencode',
      displayName: 'OpenCode',
      available: false,
      reason: 'not installed',
    }],
  });

  const outcome = await service.executeProjectImport(project, 'scheduled');
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') return;

  assert.equal(outcome.result.created, 1);
  assert.equal(requestRunCalls.length, 0);
  assert.equal(dispatchCalls, 0);
  assert.equal(outcome.result.tasks[0]?.columnId, 'backlog');
  assert.equal(outcome.result.tasks[0]?.runRequestedAt, undefined);
  assert.equal(persistedEvents.length, 1);
  assert.match(persistedEvents[0]?.content ?? '', /default agent opencode is not available/i);
});

test('JiraImportExecutionService skips durable run requests when auto-start is disabled', async () => {
  const project = makeProject({ jiraImportAutoStart: false });
  const requestRunCalls: string[] = [];
  let dispatchCalls = 0;

  const service = new JiraImportExecutionService({
    taskRepo: {
      async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
        return { task, created: true };
      },
      async requestRun(id: string): Promise<Task | undefined> {
        requestRunCalls.push(id);
        return undefined;
      },
      async insertEvent(): Promise<void> {},
    },
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
        return [makeIssue()];
      },
    }),
    onDurableRunRequested: () => {
      dispatchCalls += 1;
    },
  });

  const outcome = await service.executeProjectImport(project, 'manual');
  assert.equal(outcome.status, 'completed');
  assert.equal(requestRunCalls.length, 0);
  assert.equal(dispatchCalls, 0);
});

test('JiraImportExecutionService does not request additional runs for idempotent re-imports', async () => {
  const project = makeProject({ jiraImportAutoStart: true });
  const byIdentity = new Map<string, Task>();
  const requestRunCalls: string[] = [];

  const service = new JiraImportExecutionService({
    taskRepo: {
      async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
        const key = `${task.externalSource ?? ''}:${task.externalKey ?? ''}`;
        const existing = byIdentity.get(key);
        if (existing) return { task: existing, created: false };
        byIdentity.set(key, task);
        return { task, created: true };
      },
      async requestRun(id: string): Promise<Task | undefined> {
        requestRunCalls.push(id);
        return [...byIdentity.values()].find((candidate) => candidate.id === id);
      },
      async insertEvent(): Promise<void> {},
    },
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
        return [makeIssue()];
      },
    }),
    listAvailableAgents: () => [{
      name: 'copilot',
      displayName: 'Copilot',
      available: true,
    }],
    repoPathValidator: () => ({ valid: true }),
  });

  const firstRun = await service.executeProjectImport(project, 'manual');
  const secondRun = await service.executeProjectImport(project, 'manual');
  assert.equal(firstRun.status, 'completed');
  assert.equal(secondRun.status, 'completed');
  if (firstRun.status !== 'completed' || secondRun.status !== 'completed') return;

  assert.equal(firstRun.result.created, 1);
  assert.equal(secondRun.result.created, 0);
  assert.equal(secondRun.result.skipped, 1);
  assert.equal(requestRunCalls.length, 1);
});

test('JiraImportExecutionService persists failure metadata when Jira config is missing', async () => {
  const project = makeProject();
  const updates: Array<Record<string, unknown>> = [];

  const projectRepo: Pick<ProjectRepository, 'update'> = {
    async update(_id, update): Promise<Project | undefined> {
      updates.push(update as unknown as Record<string, unknown>);
      return project;
    },
  };

  const service = new JiraImportExecutionService({
    taskRepo: {
      async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
        return { task, created: true };
      },
      async requestRun(): Promise<Task | undefined> {
        return undefined;
      },
      async insertEvent(): Promise<void> {},
    },
    projectRepo,
    configResolver: () => ({ configured: false, reason: 'Jira import is not configured. Missing JIRA_BASE_URL.' }),
    now: (() => {
      let tick = 10_000;
      return () => {
        tick += 10;
        return tick;
      };
    })(),
  });

  await assert.rejects(
    service.executeProjectImport(project, 'manual'),
    (error: unknown) => error instanceof JiraImportNotConfiguredError,
  );

  assert.equal(updates.length, 2);
  assert.equal(typeof updates[0].jiraImportLastRunAt, 'number');
  assert.equal(typeof updates[1].jiraImportLastCompletedAt, 'number');
  assert.equal(typeof updates[1].jiraImportLastError, 'string');
  assert.match(String(updates[1].jiraImportLastError), /^jira_not_configured:/);
  assert.equal('jiraImportEnabled' in updates[1], false);
});

test('JiraImportExecutionService shares a project lock between manual and scheduled triggers', async () => {
  const project = makeProject();
  const issueGate = createDeferred<readonly JiraIssue[]>();

  const service = new JiraImportExecutionService({
    taskRepo: {
      async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
        return { task, created: true };
      },
      async requestRun(): Promise<Task | undefined> {
        return undefined;
      },
      async insertEvent(): Promise<void> {},
    },
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
        return issueGate.promise;
      },
    }),
  });

  const firstRun = service.executeProjectImport(project, 'manual');

  await assert.rejects(
    service.executeProjectImport(project, 'manual'),
    (error: unknown) => error instanceof JiraImportConflictError,
  );

  const scheduledOutcome = await service.executeProjectImport(project, 'scheduled');
  assert.deepEqual(scheduledOutcome, { status: 'skipped_overlap' });

  issueGate.resolve([makeIssue()]);
  const firstOutcome = await firstRun;
  assert.equal(firstOutcome.status, 'completed');
});
