import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentAttachment,
  AgentProvider,
  AgentResult,
  AgentSession,
  AgentSessionConfig,
} from '@codewithdan/agent-sdk-core';
import { AgentManager } from '../src/services/agent-manager.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { AgentEvent, AgentInfo, Task } from '../src/types.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-clarification',
    projectId: 'default',
    title: 'Clarification task',
    description: 'Investigate and ask only if blocked',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'idle',
    agentType: 'opencode',
    createdAt: Date.now(),
    ...overrides,
  };
}

class MemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, Task>();
  private readonly events: AgentEvent[] = [];

  constructor(initialTask: Task) {
    this.tasks.set(initialTask.id, initialTask);
  }

  async getAll(): Promise<Task[]> {
    return [...this.tasks.values()];
  }

  async getById(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  async getByExternalIdentity(_projectId: string, _source: string, _key: string): Promise<Task | undefined> {
    return undefined;
  }

  async create(task: Task): Promise<Task> {
    this.tasks.set(task.id, task);
    return task;
  }

  async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
    const existing = this.tasks.get(task.id);
    if (existing) return { task: existing, created: false };
    this.tasks.set(task.id, task);
    return { task, created: true };
  }

  async requestRun(id: string, requestedAt: number): Promise<Task | undefined> {
    return this.update(id, { runRequestedAt: requestedAt, runClaimedAt: undefined });
  }

  async claimRun(id: string, claimedAt: number): Promise<Task | undefined> {
    const task = this.tasks.get(id);
    if (!task || task.runRequestedAt == null) return undefined;
    if (task.runClaimedAt != null) return undefined;
    return this.update(id, { runClaimedAt: claimedAt });
  }

  async clearRun(id: string): Promise<Task | undefined> {
    return this.update(id, { runRequestedAt: undefined, runClaimedAt: undefined });
  }

  async getPendingRuns(): Promise<Task[]> {
    return [...this.tasks.values()].filter((task) => task.runRequestedAt != null && task.runClaimedAt == null);
  }

  async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    const existing = this.tasks.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...updates };
    this.tasks.set(id, merged);
    return merged;
  }

  async delete(id: string): Promise<boolean> {
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

type ProviderMode = 'valid' | 'malformed';

class FakeClarificationProvider implements AgentProvider {
  readonly name = 'opencode' as const;
  readonly displayName = 'Fake OpenCode';
  readonly model = 'fake-model';
  readonly sendMessages: string[] = [];
  readonly executeStarted = deferred<void>();
  private readonly executeContinue = deferred<void>();
  private aborted = false;

  constructor(
    private readonly sessionIdentity: string | null,
    private readonly mode: ProviderMode,
  ) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = this.sessionIdentity;
    return {
      sessionId,
      execute: async (_prompt: string, _attachments?: AgentAttachment[]): Promise<AgentResult> => {
        this.executeStarted.resolve(undefined);
        const timestamp = Date.now();
        if (this.mode === 'valid') {
          config.onEvent({
            id: `evt-${timestamp}`,
            contextId: config.contextId,
            type: 'command',
            content: 'Need clarification',
            timestamp,
            metadata: {
              clarification_request: {
                requestId: 'req-1',
                prompt: 'Which branch should I target?',
                choices: ['main', 'develop'],
                timestamp,
              },
            },
          });
        } else {
          config.onEvent({
            id: `evt-${timestamp}`,
            contextId: config.contextId,
            type: 'command',
            content: 'Need clarification',
            timestamp,
            metadata: {
              clarification_request: {
                requestId: 1,
                prompt: 2,
                timestamp: 'bad',
              },
            },
          });
        }

        await this.executeContinue.promise;
        if (this.aborted) {
          return { status: 'failed', error: 'aborted' };
        }
        return { status: 'complete' };
      },
      send: async (message: string, _attachments?: AgentAttachment[]): Promise<void> => {
        this.sendMessages.push(message);
        this.executeContinue.resolve(undefined);
      },
      abort: async (): Promise<void> => {
        this.aborted = true;
        this.executeContinue.resolve(undefined);
      },
      destroy: async (): Promise<void> => {},
    };
  }
}

function makeAvailableAgents(): AgentInfo[] {
  return [{ name: 'opencode', displayName: 'OpenCode', available: true }];
}

function createStatusCallback(repo: TaskRepository, taskId: string, statuses: Task['agentStatus'][]): (status: Task['agentStatus']) => Promise<void> {
  return async (status) => {
    statuses.push(status);
    const updates: Partial<Task> = { agentStatus: status };
    if (status === 'complete' || status === 'failed') updates.completedAt = Date.now();
    await repo.update(taskId, updates);
  };
}

test('clarification pause/resume keeps same session identity and rejects stale or duplicate answers deterministically', async () => {
  const task = makeTask();
  const repo = new MemoryTaskRepository(task);
  const provider = new FakeClarificationProvider('session-1', 'valid');
  const manager = new AgentManager();
  manager.initEventPersistence(repo);
  manager.registerProvider(provider);
  manager.setAvailableAgents(makeAvailableAgents());

  const statuses: Task['agentStatus'][] = [];
  manager.startAgent(task, createStatusCallback(repo, task.id, statuses));

  await provider.executeStarted.promise;
  await waitFor(() => statuses.includes('awaiting_clarification'));

  const clarificationEvents = await repo.getEventsByTaskId(task.id);
  const clarificationEvent = clarificationEvents.find((event) => event.metadata?.clarification_request?.requestId === 'req-1');
  assert.ok(clarificationEvent);
  assert.equal(clarificationEvent?.type, 'command');
  assert.equal(clarificationEvent?.metadata?.clarification_request?.prompt, 'Which branch should I target?');
  assert.deepEqual(clarificationEvent?.metadata?.clarification_request?.choices, ['main', 'develop']);

  const sessionId = manager.getSessionIdentity(task.id);
  assert.equal(sessionId, 'session-1');

  const staleResult = await manager.resumeClarification(task.id, {
    requestId: 'req-1',
    sessionId: 'stale-session',
    answer: 'main',
  });
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.code, 'stale_session');

  const taskAfterStale = await repo.getById(task.id);
  assert.equal(taskAfterStale?.agentStatus, 'awaiting_clarification');
  assert.equal(taskAfterStale?.clarificationRequest?.requestId, 'req-1');
  assert.equal(taskAfterStale?.clarificationAnswer ?? null, null);

  const answerOne = manager.resumeClarification(task.id, {
    requestId: 'req-1',
    sessionId: 'session-1',
    answer: 'main',
  });
  const answerTwo = manager.resumeClarification(task.id, {
    requestId: 'req-1',
    sessionId: 'session-1',
    answer: 'develop',
  });
  const [first, second] = await Promise.all([answerOne, answerTwo]);

  const resumedCount = [first, second].filter((result) => result.code === 'resumed').length;
  const duplicateCount = [first, second].filter((result) => result.code === 'duplicate_answer').length;
  assert.equal(resumedCount, 1);
  assert.equal(duplicateCount, 1);
  assert.equal(provider.sendMessages.length, 1);

  await waitFor(() => statuses.includes('complete'));

  const finalTask = await repo.getById(task.id);
  assert.equal(finalTask?.agentStatus, 'complete');
  assert.equal(finalTask?.clarificationRequest?.requestId, 'req-1');
  assert.equal(finalTask?.clarificationRequest?.sessionId, 'session-1');
  assert.equal(finalTask?.clarificationAnswer?.requestId, 'req-1');
  assert.equal(finalTask?.clarificationAnswer?.sessionId, 'session-1');

  manager.shutdownAll();
});

test('malformed clarification payload fails closed with a task failure event', async () => {
  const task = makeTask({ id: 'task-malformed' });
  const repo = new MemoryTaskRepository(task);
  const provider = new FakeClarificationProvider('session-malformed', 'malformed');
  const manager = new AgentManager();
  manager.initEventPersistence(repo);
  manager.registerProvider(provider);
  manager.setAvailableAgents(makeAvailableAgents());

  const statuses: Task['agentStatus'][] = [];
  manager.startAgent(task, createStatusCallback(repo, task.id, statuses));

  await waitFor(() => statuses.includes('failed'));

  const events = await repo.getEventsByTaskId(task.id);
  const failureEvent = events.find((event) => event.type === 'error' && event.content.includes('malformed clarification_request payload'));
  assert.ok(failureEvent);

  const updated = await repo.getById(task.id);
  assert.equal(updated?.agentStatus, 'failed');

  manager.shutdownAll();
});

test('provider without stable session identity fails closed before execute', async () => {
  const task = makeTask({ id: 'task-sessionless' });
  const repo = new MemoryTaskRepository(task);
  const provider = new FakeClarificationProvider(null, 'valid');
  const manager = new AgentManager();
  manager.initEventPersistence(repo);
  manager.registerProvider(provider);
  manager.setAvailableAgents(makeAvailableAgents());

  const statuses: Task['agentStatus'][] = [];
  manager.startAgent(task, createStatusCallback(repo, task.id, statuses));

  await waitFor(() => statuses.includes('failed'));

  const events = await repo.getEventsByTaskId(task.id);
  const failureEvent = events.find((event) => event.type === 'error' && event.content.includes('session.sessionId'));
  assert.ok(failureEvent);
  assert.equal(provider.sendMessages.length, 0);

  manager.shutdownAll();
});
