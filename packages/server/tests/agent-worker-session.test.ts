import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { createAgentRouter } from '../src/routes/agent.js';
import type { Task, Worker } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { WorkerRepository, WorkerTaskCommand } from '../src/repositories/worker-types.js';
import type { AgentManager } from '../src/services/agent-manager.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'default',
    title: 'Task',
    description: 'desc',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'executing',
    agentType: 'opencode',
    createdAt: 1,
    assignedWorkerId: 'worker-1',
    workerLeaseExpiresAt: Date.now() + 60_000,
    repoPath: '/private/repo',
    worktreePath: '/private/worktree',
    ...overrides,
  };
}

function createRepo(initialTask: Task): {
  readonly repo: TaskRepository;
  readonly current: () => Task;
} {
  let task = initialTask;
  const repo: TaskRepository = {
    async getAll(): Promise<Task[]> { return [task]; },
    async getById(id: string): Promise<Task | undefined> { return id === task.id ? task : undefined; },
    async getByExternalIdentity(): Promise<Task | undefined> { return undefined; },
    async create(value: Task): Promise<Task> { task = value; return value; },
    async createIdempotent(value: Task): Promise<{ task: Task; created: boolean }> {
      task = value;
      return { task: value, created: true };
    },
    async requestRun(): Promise<Task | undefined> { return undefined; },
    async claimRun(): Promise<Task | undefined> { return undefined; },
    async clearRun(): Promise<Task | undefined> { return undefined; },
    async getPendingRuns(): Promise<Task[]> { return []; },
    async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
      if (id !== task.id) return undefined;
      task = { ...task, ...updates };
      return task;
    },
    async delete(): Promise<boolean> { return false; },
    async count(): Promise<number> { return 1; },
    async insertEvent(): Promise<void> {},
    async getEventsByTaskId(): Promise<[]> { return []; },
    async deleteEventsByTaskId(): Promise<void> {},
    async getArchivedTasks(): Promise<Task[]> { return []; },
  };
  return { repo, current: () => task };
}

class FakeWorkerRepo implements WorkerRepository {
  readonly queued: WorkerTaskCommand[] = [];
  readonly sessions: Array<{ taskId: string; sessionId: string; baseUrl: string; updatedAt: number }> = [];
  readonly clearedTaskIds: string[] = [];

  async register(): Promise<Worker> { return this.worker(); }
  async heartbeat(): Promise<Worker> { return this.worker(); }
  async getById(): Promise<Worker | undefined> { return this.worker(); }
  async getByTokenHash(hash: string): Promise<(Worker & { readonly tokenHash: string }) | undefined> {
    const expected = crypto.createHash('sha256').update('worker-token').digest('hex');
    if (hash !== expected) return undefined;
    return { ...this.worker(), tokenHash: hash };
  }
  async list(): Promise<Worker[]> { return [this.worker()]; }
  async markOffline(): Promise<Worker[]> { return []; }
  async registerTaskSession(taskId: string, sessionId: string, baseUrl: string, updatedAt: number): Promise<void> {
    this.sessions.push({ taskId, sessionId, baseUrl, updatedAt });
  }
  async getTaskSessions(taskId: string): Promise<readonly { sessionId: string; baseUrl: string; updatedAt: number }[]> {
    return this.sessions
      .filter((session) => session.taskId === taskId)
      .map(({ sessionId, baseUrl, updatedAt }) => ({ sessionId, baseUrl, updatedAt }));
  }
  async clearTaskSessions(taskId: string): Promise<void> {
    this.clearedTaskIds.push(taskId);
    this.sessions.splice(0, this.sessions.length, ...this.sessions.filter((session) => session.taskId !== taskId));
  }
  async enqueueTaskCommand(_taskId: string, command: WorkerTaskCommand): Promise<void> {
    this.queued.push(command);
  }
  async claimTaskCommands(): Promise<readonly WorkerTaskCommand[]> { return []; }
  async clearTaskCommands(): Promise<void> {}

  private worker(): Worker {
    return {
      id: 'worker-1',
      name: 'worker',
      status: 'online',
      agentTypes: ['opencode'],
      maxConcurrentTasks: 1,
      registeredAt: 1,
      lastHeartbeatAt: 1,
      updatedAt: 1,
    };
  }
}

function createManager(sessionId: string | null = 'ses_worker_1'): AgentManager {
  return {
    isRunning: () => false,
    stopAgent: async () => false,
    startAgent: () => {},
    resetEvents: () => {},
    sendMessage: async () => true,
    resumeClarification: async () => ({ ok: true, code: 'resumed', message: 'ok' }),
    getSessionIdentity: () => sessionId,
  } as unknown as AgentManager;
}

async function withAgentApp(
  repo: TaskRepository,
  agentManager: AgentManager,
  workerRepo: WorkerRepository,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createAgentRouter(repo, agentManager, undefined, undefined, workerRepo));

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('POST /api/tasks/:id/message queues a worker follow-up command for the same task session', async () => {
  const { repo } = createRepo(makeTask({ agentStatus: 'executing' }));
  const workerRepo = new FakeWorkerRepo();
  await withAgentApp(repo, createManager(), workerRepo, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: ' follow-up ', attachmentIds: ['att-1', 2, 'att-2'] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
  });

  assert.equal(workerRepo.queued.length, 1);
  assert.equal(workerRepo.queued[0]?.type, 'message');
  assert.equal(workerRepo.queued[0]?.message, 'follow-up');
  assert.deepEqual(workerRepo.queued[0]?.attachmentIds, ['att-1', 'att-2']);
});

// SHOULD-FIX (round 2): a follow-up message with no live worker lease folds
// into the description and starts a fresh run (the "requeue" branch). Any
// clarificationRequest/clarificationAnswer left over from an EARLIER,
// already-finished clarification cycle must not survive into this new run —
// otherwise workerResume() would inject that stale Q&A into unrelated work.
test('POST /api/tasks/:id/message clears a stale clarificationRequest/Answer when requeuing a fresh run', async () => {
  const { repo, current } = createRepo(makeTask({
    agentStatus: 'failed',
    workerLeaseExpiresAt: undefined,
    clarificationRequest: { requestId: 'req-old', sessionId: 'ses_old', prompt: 'Old question?', timestamp: 1 },
    clarificationAnswer: { requestId: 'req-old', sessionId: 'ses_old', answer: 'Old answer', timestamp: 2 },
  }));
  const workerRepo = new FakeWorkerRepo();
  await withAgentApp(repo, createManager(), workerRepo, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'please continue' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, code: 'requeued_with_followup' });
  });

  const updated = current();
  assert.equal(updated.agentStatus, 'planning');
  assert.equal(updated.clarificationRequest ?? null, null);
  assert.equal(updated.clarificationAnswer ?? null, null);
});

test('POST /api/tasks/:id/clarification/resume queues clarification command for assigned worker', async () => {
  const { repo } = createRepo(makeTask({ agentStatus: 'awaiting_clarification' }));
  const workerRepo = new FakeWorkerRepo();
  await withAgentApp(repo, createManager(), workerRepo, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/clarification/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'req-1', sessionId: 'ses_worker_1', answer: 'main' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      code: 'queued_for_worker',
      message: 'clarification queued for worker session',
    });
  });

  assert.equal(workerRepo.queued.length, 1);
  assert.deepEqual(workerRepo.queued[0], {
    id: workerRepo.queued[0]?.id,
    type: 'clarification',
    createdAt: workerRepo.queued[0]?.createdAt,
    requestId: 'req-1',
    sessionId: 'ses_worker_1',
    answer: 'main',
  });
});

test('POST /api/tasks/:id/stop queues cancel for worker task and marks agentStatus failed', async () => {
  const created = createRepo(makeTask({ agentStatus: 'planning' }));
  const workerRepo = new FakeWorkerRepo();
  await withAgentApp(created.repo, createManager(), workerRepo, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/stop`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.agentStatus, 'failed');
  });

  assert.equal(workerRepo.queued.length, 1);
  assert.equal(workerRepo.queued[0]?.type, 'cancel');
  assert.equal(created.current().agentStatus, 'failed');
});

// NIT (round 2): hasActiveWorkerLease now requires a genuinely live lease for
// planning/executing too, not just the status. Pin the resulting behavior at
// the two call sites this changes: a lapsed (but not yet swept) lease means
// /stop no longer queues a cancel command that nobody will ever poll for —
// it falls through to agentManager.stopAgent, which correctly 409s when
// there is no in-process session either.
test('POST /api/tasks/:id/stop 409s (rather than queuing an unpollable cancel) when the worker lease has already lapsed', async () => {
  const { repo } = createRepo(makeTask({ id: 'task-lapsed-stop', agentStatus: 'executing', workerLeaseExpiresAt: Date.now() - 1 }));
  const workerRepo = new FakeWorkerRepo();
  await withAgentApp(repo, createManager(), workerRepo, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-lapsed-stop/stop`, { method: 'POST' });
    assert.equal(response.status, 409);
  });

  assert.equal(workerRepo.queued.length, 0, 'no cancel command should be queued for a lapsed lease');
});

// Same lapsed-lease task via /message: it takes the "requeue as a fresh run"
// branch instead of queuing a follow-up command into the same dead lease.
test('POST /api/tasks/:id/message requeues a fresh run (rather than queuing an unpollable command) when the worker lease has already lapsed', async () => {
  const { repo, current } = createRepo(makeTask({ id: 'task-lapsed-message', agentStatus: 'executing', workerLeaseExpiresAt: Date.now() - 1 }));
  const workerRepo = new FakeWorkerRepo();
  await withAgentApp(repo, createManager(), workerRepo, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-lapsed-message/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'please continue' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, code: 'requeued_with_followup' });
  });

  assert.equal(workerRepo.queued.length, 0, 'no follow-up command should be queued for a lapsed lease');
  assert.equal(current().agentStatus, 'planning');
});

test('GET /api/tasks/:id/opencode-session returns session link without leaking workspace paths', async () => {
  const { repo } = createRepo(makeTask());
  const workerRepo = new FakeWorkerRepo();
  workerRepo.sessions.push({
    taskId: 'task-1',
    sessionId: 'ses_worker_1',
    baseUrl: 'http://127.0.0.1:4096',
    updatedAt: Date.now(),
  });

  await withAgentApp(repo, createManager('ses_worker_1'), workerRepo, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/opencode-session`);
    assert.equal(response.status, 200);
    const body = await response.json() as { sessionId: string; url: string };
    assert.deepEqual(body, {
      sessionId: 'ses_worker_1',
      url: 'http://127.0.0.1:4096',
    });
    assert.equal(JSON.stringify(body).includes('/private/'), false);
  });
});

test('GET /api/tasks/:id/opencode-session returns 404 for a worker restart with no live matching session', async () => {
  const { repo } = createRepo(makeTask());
  const workerRepo = new FakeWorkerRepo();
  workerRepo.sessions.push({
    taskId: 'task-1',
    sessionId: 'ses_worker_1',
    baseUrl: 'http://127.0.0.1:4096',
    updatedAt: Date.now(),
  });

  await withAgentApp(repo, createManager(null), workerRepo, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/opencode-session`);
    assert.equal(response.status, 404);
  });
});

test('GET /api/tasks/:id/opencode-session returns 404 when the worker lease is expired', async () => {
  const { repo } = createRepo(makeTask({ workerLeaseExpiresAt: Date.now() - 1 }));
  const workerRepo = new FakeWorkerRepo();
  workerRepo.sessions.push({
    taskId: 'task-1',
    sessionId: 'ses_worker_1',
    baseUrl: 'http://127.0.0.1:4096',
    updatedAt: Date.now(),
  });

  await withAgentApp(repo, createManager('ses_worker_1'), workerRepo, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/opencode-session`);
    assert.equal(response.status, 404);
  });
});

test('GET /api/tasks/:id/opencode-session returns 404 when the live session does not match the registered mapping', async () => {
  const { repo } = createRepo(makeTask());
  const workerRepo = new FakeWorkerRepo();
  workerRepo.sessions.push({
    taskId: 'task-1',
    sessionId: 'ses_other',
    baseUrl: 'http://127.0.0.1:4096',
    updatedAt: Date.now(),
  });

  await withAgentApp(repo, createManager('ses_worker_1'), workerRepo, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/opencode-session`);
    assert.equal(response.status, 404);
  });
});

test('GET /api/tasks/:id/opencode-session returns 404 when the task is not in a worker-active status', async () => {
  const { repo } = createRepo(makeTask({ agentStatus: 'idle' }));
  const workerRepo = new FakeWorkerRepo();
  workerRepo.sessions.push({
    taskId: 'task-1',
    sessionId: 'ses_worker_1',
    baseUrl: 'http://127.0.0.1:4096',
    updatedAt: Date.now(),
  });

  await withAgentApp(repo, createManager('ses_worker_1'), workerRepo, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/opencode-session`);
    assert.equal(response.status, 404);
  });
});

test('GET /api/tasks/:id/opencode-session returns 404 for completed and expired worker tasks', async () => {
  for (const agentStatus of ['complete', 'failed'] as const) {
    const { repo } = createRepo(makeTask({ agentStatus }));
    const workerRepo = new FakeWorkerRepo();
    workerRepo.sessions.push({
      taskId: 'task-1',
      sessionId: 'ses_worker_1',
      baseUrl: 'http://127.0.0.1:4096',
      updatedAt: Date.now(),
    });

    await withAgentApp(repo, createManager('ses_worker_1'), workerRepo, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/tasks/task-1/opencode-session`);
      assert.equal(response.status, 404);
    });
  }
});

test('POST /api/tasks/:id/stop clears worker session mappings for assigned tasks', async () => {
  const { repo } = createRepo(makeTask({ id: 'task-stop-1', agentStatus: 'planning' }));
  const workerRepo = new FakeWorkerRepo();
  workerRepo.sessions.push({
    taskId: 'task-stop-1',
    sessionId: 'ses_worker_1',
    baseUrl: 'http://127.0.0.1:4096',
    updatedAt: Date.now(),
  });

  await withAgentApp(repo, createManager('ses_worker_1'), workerRepo, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-stop-1/stop`, { method: 'POST' });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(workerRepo.clearedTaskIds, ['task-stop-1']);
});
