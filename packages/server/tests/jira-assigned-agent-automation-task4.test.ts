import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentAttachment,
  AgentProvider,
  AgentResult,
  AgentSession,
  AgentSessionConfig,
} from '@codewithdan/agent-sdk-core';
import type { JiraIssue } from '../src/jira/client.js';
import { JiraImportExecutionService } from '../src/jira/import-execution.js';
import type { TaskRepository } from '../src/repositories/types.js';
import { startAgentForTask } from '../src/routes/helpers.js';
import { dispatchPendingRuns } from '../src/run-dispatcher.js';
import { AgentManager } from '../src/services/agent-manager.js';
import {
  shouldRecoverGroupChildAsFailed,
  shouldRecoverGroupChildToIdle,
  shouldRecoverStandaloneTaskAsFailed,
} from '../src/startup-recovery.js';
import type { AgentEvent, AgentInfo, Project, Task } from '../src/types.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!(await condition())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-task4',
    name: 'Task 4 Project',
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    repoPath: process.cwd(),
    defaultAgentType: 'opencode',
    jiraImportEnabled: true,
    jiraImportIntervalMinutes: 15,
    jiraImportAutoStart: true,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '10001',
    key: 'PROJ-10001',
    summary: 'Auto-start imported task',
    description: 'Execute and ask clarification only when blocked',
    status: 'To Do',
    issueType: 'Task',
    ...overrides,
  };
}

class MemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, Task>();
  private readonly events: AgentEvent[] = [];
  private readonly statusHistory = new Map<string, Task['agentStatus'][]>();

  constructor(initialTasks: readonly Task[] = []) {
    for (const task of initialTasks) {
      this.tasks.set(task.id, task);
      this.statusHistory.set(task.id, [task.agentStatus]);
    }
  }

  getStatusHistory(taskId: string): readonly Task['agentStatus'][] {
    return this.statusHistory.get(taskId) ?? [];
  }

  async getAll(): Promise<Task[]> {
    return [...this.tasks.values()];
  }

  async getById(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  async getByExternalIdentity(projectId: string, source: string, key: string): Promise<Task | undefined> {
    return [...this.tasks.values()].find((task) => task.projectId === projectId && task.externalSource === source && task.externalKey === key);
  }

  async create(task: Task): Promise<Task> {
    this.tasks.set(task.id, task);
    this.statusHistory.set(task.id, [task.agentStatus]);
    return task;
  }

  async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
    if (task.externalSource && task.externalKey) {
      const existing = await this.getByExternalIdentity(task.projectId, task.externalSource, task.externalKey);
      if (existing) return { task: existing, created: false };
    }
    await this.create(task);
    return { task, created: true };
  }

  async requestRun(id: string, requestedAt: number): Promise<Task | undefined> {
    return this.update(id, { runRequestedAt: requestedAt, runClaimedAt: undefined });
  }

  async claimRun(id: string, claimedAt: number): Promise<Task | undefined> {
    const task = this.tasks.get(id);
    if (!task || task.runRequestedAt == null) return undefined;
    if (task.runClaimedAt != null && task.runClaimedAt >= claimedAt - 30_000) return undefined;
    if (task.agentStatus !== 'idle' && task.agentStatus !== 'planning') return undefined;
    return this.update(id, { runClaimedAt: claimedAt });
  }

  async clearRun(id: string): Promise<Task | undefined> {
    return this.update(id, { runRequestedAt: undefined, runClaimedAt: undefined });
  }

  async getPendingRuns(staleBefore = Date.now() - 30_000): Promise<Task[]> {
    return [...this.tasks.values()].filter((task) => {
      if (task.runRequestedAt == null) return false;
      const notClaimed = task.runClaimedAt == null;
      const staleClaim = typeof task.runClaimedAt === 'number' && task.runClaimedAt < staleBefore;
      const claimableStatus = task.agentStatus === 'idle' || task.agentStatus === 'planning';
      return claimableStatus && (notClaimed || staleClaim);
    });
  }

  async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    const existing = this.tasks.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...updates };
    this.tasks.set(id, merged);
    if (merged.agentStatus !== existing.agentStatus) {
      const history = this.statusHistory.get(id) ?? [existing.agentStatus];
      history.push(merged.agentStatus);
      this.statusHistory.set(id, history);
    }
    return merged;
  }

  async delete(id: string): Promise<boolean> {
    this.statusHistory.delete(id);
    return this.tasks.delete(id);
  }

  async count(): Promise<number> {
    return this.tasks.size;
  }

  async insertEvent(event: AgentEvent): Promise<void> {
    this.events.push(event);
  }

  async getEventsByTaskId(taskId: string): Promise<AgentEvent[]> {
    return this.events.filter((event) => event.taskId === taskId);
  }

  async deleteEventsByTaskId(taskId: string): Promise<void> {
    let idx = this.events.length - 1;
    while (idx >= 0) {
      if (this.events[idx].taskId === taskId) this.events.splice(idx, 1);
      idx -= 1;
    }
  }

  async getArchivedTasks(): Promise<Task[]> {
    return [...this.tasks.values()].filter((task) => task.archived === true);
  }
}

class FakeOpenCodeProvider implements AgentProvider {
  readonly name = 'opencode' as const;
  readonly displayName = 'Fake OpenCode';
  readonly model = 'fake-opencode-model';
  readonly sendMessages: string[] = [];
  readonly executeStarted = deferred<void>();
  readonly sessionId = 'session-import-clarification';
  private readonly executeContinue = deferred<void>();

  capturedSystemPrompt: string | null = null;
  capturedEnvAtCreateSession: { jiraApiToken: string | undefined; jiraUserEmail: string | undefined } | null = null;
  capturedEnvAtExecute: { jiraApiToken: string | undefined; jiraUserEmail: string | undefined } | null = null;
  capturedEnvAtSend: { jiraApiToken: string | undefined; jiraUserEmail: string | undefined } | null = null;

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.capturedSystemPrompt = config.systemPrompt;
    this.capturedEnvAtCreateSession = {
      jiraApiToken: process.env.JIRA_API_TOKEN,
      jiraUserEmail: process.env.JIRA_USER_EMAIL,
    };

    return {
      sessionId: this.sessionId,
      execute: async (_prompt: string, _attachments?: AgentAttachment[]): Promise<AgentResult> => {
        this.capturedEnvAtExecute = {
          jiraApiToken: process.env.JIRA_API_TOKEN,
          jiraUserEmail: process.env.JIRA_USER_EMAIL,
        };
        this.executeStarted.resolve(undefined);
        const timestamp = Date.now();
        config.onEvent({
          id: `clarify-${timestamp}`,
          contextId: config.contextId,
          type: 'command',
          content: 'blocked by unknown branch',
          timestamp,
          metadata: {
            clarification_request: {
              requestId: 'clarify-1',
              prompt: 'Which branch should I target?',
              choices: ['main', 'develop'],
              timestamp,
            },
          },
        });
        await this.executeContinue.promise;
        return { status: 'complete' };
      },
      send: async (message: string, _attachments?: AgentAttachment[]): Promise<void> => {
        this.capturedEnvAtSend = {
          jiraApiToken: process.env.JIRA_API_TOKEN,
          jiraUserEmail: process.env.JIRA_USER_EMAIL,
        };
        this.sendMessages.push(message);
        this.executeContinue.resolve(undefined);
      },
      abort: async (): Promise<void> => {
        this.executeContinue.resolve(undefined);
      },
      destroy: async (): Promise<void> => {},
    };
  }
}

function makeAvailableAgents(available: boolean, reason?: string): AgentInfo[] {
  return [{ name: 'opencode', displayName: 'OpenCode', available, reason }];
}

test('scheduled Jira import auto-start reaches planning/executing, pauses for clarification, resumes same session, and keeps Jira secrets out of generated system prompt', async () => {
  const priorToken = process.env.JIRA_API_TOKEN;
  const priorUser = process.env.JIRA_USER_EMAIL;
  const jiraTokenSecret = 'task4-secret-token-value';
  const jiraUserSecret = 'task4-user@example.com';

  process.env.JIRA_API_TOKEN = jiraTokenSecret;
  process.env.JIRA_USER_EMAIL = jiraUserSecret;

  const taskRepo = new MemoryTaskRepository();
  const manager = new AgentManager();
  manager.initEventPersistence(taskRepo);
  const provider = new FakeOpenCodeProvider();
  manager.registerProvider(provider);
  manager.setAvailableAgents(makeAvailableAgents(true));

  const project = makeProject();

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
        userEmail: jiraUserSecret,
        apiToken: jiraTokenSecret,
        isDataCenter: false,
      },
    }),
    clientFactory: () => ({
      async listAssignedIssues(): Promise<readonly JiraIssue[]> {
        return [makeIssue()];
      },
    }),
    listAvailableAgents: () => manager.getAvailableAgents(),
    onDurableRunRequested: async () => {
      await dispatchPendingRuns({
        taskRepo,
        isTaskRunning: (taskId) => manager.isRunning(taskId),
        dispatchTask: async (task) => {
          await startAgentForTask(task, taskRepo, manager);
        },
      });
    },
  });

  try {
    const outcome = await service.executeProjectImport(project, 'scheduled');
    assert.equal(outcome.status, 'completed');
    if (outcome.status !== 'completed') return;
    assert.equal(outcome.result.created, 1);

    const importedTaskId = outcome.result.tasks[0]?.id;
    assert.ok(importedTaskId, 'expected one imported task id');

    await provider.executeStarted.promise;
    await waitFor(async () => {
      const task = await taskRepo.getById(importedTaskId);
      return task?.agentStatus === 'awaiting_clarification';
    });

    const taskWhileAwaiting = await taskRepo.getById(importedTaskId);
    assert.equal(taskWhileAwaiting?.agentStatus, 'awaiting_clarification');
    assert.equal(taskWhileAwaiting?.clarificationRequest?.requestId, 'clarify-1');
    assert.equal(taskWhileAwaiting?.clarificationAnswer ?? null, null);
    assert.equal(manager.getSessionIdentity(importedTaskId), provider.sessionId);

    const resumeResult = await manager.resumeClarification(importedTaskId, {
      requestId: 'clarify-1',
      sessionId: provider.sessionId,
      answer: 'develop',
    });
    assert.equal(resumeResult.ok, true);
    assert.equal(resumeResult.code, 'resumed');

    await waitFor(async () => {
      const task = await taskRepo.getById(importedTaskId);
      return task?.agentStatus === 'complete';
    });

    const statusHistory = taskRepo.getStatusHistory(importedTaskId);
    assert.ok(statusHistory.includes('planning'));
    assert.ok(statusHistory.includes('executing'));
    assert.ok(statusHistory.includes('awaiting_clarification'));
    assert.equal(statusHistory.at(-1), 'complete');
    assert.equal(provider.sendMessages.length, 1);
    assert.equal(provider.sendMessages[0], 'develop');

    const systemPrompt = provider.capturedSystemPrompt;
    assert.ok(systemPrompt, 'expected generated system prompt to be captured');
    assert.match(systemPrompt ?? '', /clarification_request/);
    assert.match(systemPrompt ?? '', /blocking unknowns/i);
    assert.match(systemPrompt ?? '', /WAIT for the answer/i);
    assert.ok(!(systemPrompt ?? '').includes('JIRA_API_TOKEN'));
    assert.ok(!(systemPrompt ?? '').includes('JIRA_USER_EMAIL'));
    assert.ok(!(systemPrompt ?? '').includes(jiraTokenSecret));
    assert.ok(!(systemPrompt ?? '').includes(jiraUserSecret));
    assert.ok(!/authorization\s*:/i.test(systemPrompt ?? ''));

    assert.equal(provider.capturedEnvAtCreateSession?.jiraApiToken, undefined);
    assert.equal(provider.capturedEnvAtCreateSession?.jiraUserEmail, undefined);
    assert.equal(provider.capturedEnvAtExecute?.jiraApiToken, undefined);
    assert.equal(provider.capturedEnvAtExecute?.jiraUserEmail, undefined);
    assert.equal(provider.capturedEnvAtSend?.jiraApiToken, undefined);
    assert.equal(provider.capturedEnvAtSend?.jiraUserEmail, undefined);
  } finally {
    manager.shutdownAll();
    if (priorToken === undefined) {
      delete process.env.JIRA_API_TOKEN;
    } else {
      process.env.JIRA_API_TOKEN = priorToken;
    }
    if (priorUser === undefined) {
      delete process.env.JIRA_USER_EMAIL;
    } else {
      process.env.JIRA_USER_EMAIL = priorUser;
    }
  }
});

test('scheduled Jira import with auto-start skips dispatch and writes a task error event when project default agent is unavailable', async () => {
  const taskRepo = new MemoryTaskRepository();
  const manager = new AgentManager();
  manager.initEventPersistence(taskRepo);
  manager.registerProvider(new FakeOpenCodeProvider());
  manager.setAvailableAgents(makeAvailableAgents(false, 'Fake unavailable agent'));

  const project = makeProject();
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
        return [makeIssue({ id: '10002', key: 'PROJ-10002' })];
      },
    }),
    listAvailableAgents: () => manager.getAvailableAgents(),
    onDurableRunRequested: async () => {
      await dispatchPendingRuns({
        taskRepo,
        isTaskRunning: (taskId) => manager.isRunning(taskId),
        dispatchTask: async (task) => {
          await startAgentForTask(task, taskRepo, manager);
        },
      });
    },
  });

  try {
    const outcome = await service.executeProjectImport(project, 'scheduled');
    assert.equal(outcome.status, 'completed');
    if (outcome.status !== 'completed') return;
    const importedTaskId = outcome.result.tasks[0]?.id;
    assert.ok(importedTaskId, 'expected one imported task id');

    const importedTask = await taskRepo.getById(importedTaskId);
    assert.equal(importedTask?.agentStatus, 'idle');
    assert.equal(importedTask?.columnId, 'backlog');
    assert.equal(importedTask?.runRequestedAt, undefined);
    assert.equal(importedTask?.runClaimedAt, undefined);
    assert.equal(manager.isRunning(importedTaskId), false);

    const statusHistory = taskRepo.getStatusHistory(importedTaskId);
    assert.deepEqual(statusHistory, ['idle']);

    const events = await taskRepo.getEventsByTaskId(importedTaskId);
    assert.ok(events.some((event) => event.type === 'error' && event.content.includes('not available')));
    assert.ok(!events.some((event) => event.type === 'complete'));
  } finally {
    manager.shutdownAll();
  }
});

test('startup recovery safety assertions keep awaiting_clarification out of failed-reset paths', () => {
  assert.equal(shouldRecoverStandaloneTaskAsFailed('planning'), true);
  assert.equal(shouldRecoverStandaloneTaskAsFailed('executing'), true);
  assert.equal(shouldRecoverStandaloneTaskAsFailed('awaiting_clarification'), false);

  assert.equal(shouldRecoverGroupChildAsFailed('executing'), true);
  assert.equal(shouldRecoverGroupChildAsFailed('awaiting_clarification'), false);
  assert.equal(shouldRecoverGroupChildToIdle('planning'), true);
  assert.equal(shouldRecoverGroupChildToIdle('awaiting_clarification'), false);
});
