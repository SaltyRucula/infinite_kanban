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
import type { Task, TaskGroup, AgentEvent } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
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

function makeTask(id: string): Task {
  return {
    id,
    projectId: 'default',
    title: id,
    description: '',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'idle',
    agentType: 'opencode',
    createdAt: Date.now(),
  };
}

function makeGroup(): TaskGroup {
  return {
    id: 'group-1',
    projectId: 'default',
    title: 'Group',
    priority: 'medium',
    columnId: 'in-progress',
    maxConcurrency: 1,
    createdAt: Date.now(),
  };
}

class MemoryTaskRepo implements TaskRepository {
  private readonly tasks = new Map<string, Task>();
  private readonly events: AgentEvent[] = [];

  constructor(initial: readonly Task[]) {
    for (const task of initial) this.tasks.set(task.id, task);
  }

  async getAll(): Promise<Task[]> { return [...this.tasks.values()]; }
  async getById(id: string): Promise<Task | undefined> { return this.tasks.get(id); }
  async getByExternalIdentity(): Promise<Task | undefined> { return undefined; }
  async create(task: Task): Promise<Task> { this.tasks.set(task.id, task); return task; }
  async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> { this.tasks.set(task.id, task); return { task, created: true }; }
  async requestRun(): Promise<Task | undefined> { return undefined; }
  async claimRun(): Promise<Task | undefined> { return undefined; }
  async clearRun(): Promise<Task | undefined> { return undefined; }
  async getPendingRuns(): Promise<Task[]> { return []; }
  async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    const current = this.tasks.get(id);
    if (!current) return undefined;
    const next = { ...current, ...updates };
    this.tasks.set(id, next);
    return next;
  }
  async delete(id: string): Promise<boolean> { return this.tasks.delete(id); }
  async count(): Promise<number> { return this.tasks.size; }
  async insertEvent(event: AgentEvent): Promise<void> { this.events.push(event); }
  async getEventsByTaskId(taskId: string): Promise<AgentEvent[]> { return this.events.filter((e) => e.taskId === taskId); }
  async deleteEventsByTaskId(taskId: string): Promise<void> {
    let i = this.events.length - 1;
    while (i >= 0) {
      if (this.events[i]?.taskId === taskId) this.events.splice(i, 1);
      i -= 1;
    }
  }
  async getArchivedTasks(): Promise<Task[]> { return []; }
}

class QueueClarificationProvider implements AgentProvider {
  readonly name = 'opencode' as const;
  readonly displayName = 'OpenCode';
  readonly model = 'group-queue-test';

  readonly secondTaskStarted = deferred<void>();
  private readonly firstTaskContinue = deferred<void>();
  private readonly secondTaskContinue = deferred<void>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  completeSecondTask(): void {
    this.secondTaskContinue.resolve(undefined);
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const isFirst = config.contextId === 'task-1';
    const requestId = `req-${config.contextId}`;

    return {
      sessionId: `session-${config.contextId}`,
      execute: async (_prompt: string, _attachments?: AgentAttachment[]): Promise<AgentResult> => {
        if (isFirst) {
          const ts = Date.now();
          config.onEvent({
            id: `evt-${config.contextId}`,
            contextId: config.contextId,
            type: 'command',
            content: 'clarification required',
            timestamp: ts,
            metadata: {
              clarification_request: {
                requestId,
                prompt: 'Which branch should I target?',
                choices: ['main', 'develop'],
                timestamp: ts,
              },
            },
          });
          await this.firstTaskContinue.promise;
          return { status: 'complete' };
        }

        this.secondTaskStarted.resolve(undefined);
        await this.secondTaskContinue.promise;
        return { status: 'complete' };
      },
      send: async (_message: string, _attachments?: AgentAttachment[]): Promise<void> => {
        if (isFirst) this.firstTaskContinue.resolve(undefined);
      },
      abort: async (): Promise<void> => {
        if (isFirst) this.firstTaskContinue.resolve(undefined);
        this.secondTaskContinue.resolve(undefined);
      },
      destroy: async (): Promise<void> => {},
    };
  }
}

test('group queue frees a slot while awaiting clarification and allows resumed child to execute without blocking', async () => {
  const task1 = makeTask('task-1');
  const task2 = makeTask('task-2');
  const repo = new MemoryTaskRepo([task1, task2]);
  const provider = new QueueClarificationProvider();
  const manager = new AgentManager();
  manager.initEventPersistence(repo);
  manager.registerProvider(provider);
  manager.setAvailableAgents([{ name: 'opencode', displayName: 'OpenCode', available: true }]);

  const statuses = new Map<string, Task['agentStatus'][]>([
    [task1.id, []],
    [task2.id, []],
  ]);

  manager.startGroup(
    makeGroup(),
    [task1, task2],
    (task) => async (status) => {
      statuses.get(task.id)?.push(status);
      await repo.update(task.id, { agentStatus: status });
    },
    () => async () => {},
    async () => {},
  );

  await provider.secondTaskStarted.promise;
  await waitFor(() => (statuses.get(task1.id) ?? []).includes('awaiting_clarification'));
  await waitFor(() => (statuses.get(task2.id) ?? []).includes('executing'));

  const sessionId = manager.getSessionIdentity(task1.id);
  assert.ok(sessionId);
  const resumed = await manager.resumeClarification(task1.id, {
    requestId: 'req-task-1',
    sessionId,
    answer: 'main',
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.code, 'resumed');
  await waitFor(() => (statuses.get(task1.id) ?? []).includes('executing'));

  provider.completeSecondTask();
  await waitFor(() => (statuses.get(task1.id) ?? []).includes('complete'));
  await waitFor(() => (statuses.get(task2.id) ?? []).includes('complete'));

  manager.shutdownAll();
});
