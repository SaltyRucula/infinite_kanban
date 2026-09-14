import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import test from 'node:test';
import crypto from 'node:crypto';
import { createWorkersRouter } from '../src/routes/workers.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { WorkerRepository } from '../src/repositories/worker-types.js';
import type { AgentEvent, Task, Worker } from '../src/types.js';

type QueuedWorkerCommand = {
  readonly id: string;
  readonly type: 'message' | 'clarification' | 'cancel';
  readonly createdAt: number;
  readonly message?: string;
  readonly attachmentIds?: readonly string[];
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly answer?: string;
};

const worker: Worker = {
  id: 'worker-1',
  name: 'worker',
  status: 'online',
  agentTypes: ['codex'],
  maxConcurrentTasks: 1,
  registeredAt: 1,
  lastHeartbeatAt: 1,
  updatedAt: 1,
};

const task: Task = {
  id: 'task-1',
  title: 'Implement story',
  description: 'Story details',
  priority: 'high',
  columnId: 'in-progress',
  agentStatus: 'executing',
  createdAt: 1,
  projectId: 'project-secret',
  agentType: 'codex',
  branchName: 'feature/story',
  baseBranch: 'main',
  useWorktree: true,
  repoPath: '/private/repository',
  worktreePath: '/private/worktree',
  timeoutMinutes: 30,
  labels: ['backend', 'urgent'],
  agentPreference: 'fast-coder',
  assignedWorkerId: worker.id,
};

class FakeTaskRepository implements TaskRepository {
  private claimed = false;

  async getAll(): Promise<Task[]> { return []; }
  async getById(): Promise<Task | undefined> { return task; }
  async getByExternalIdentity(): Promise<Task | undefined> { return undefined; }
  async create(value: Task): Promise<Task> { return value; }
  async createIdempotent(value: Task): Promise<{ task: Task; created: boolean }> { return { task: value, created: true }; }
  async requestRun(): Promise<Task | undefined> { return undefined; }
  async claimRun(): Promise<Task | undefined> { return undefined; }
  async clearRun(): Promise<Task | undefined> { return undefined; }
  async getPendingRuns(): Promise<Task[]> { return []; }
  async assignToWorker(): Promise<Task | undefined> { return undefined; }
  async getWorkerAssignments(): Promise<Task[]> { return [task]; }
  async claimWorkerTask(): Promise<Task | undefined> { this.claimed = true; return task; }
  async renewWorkerLease(): Promise<boolean> { return this.claimed; }
  async isWorkerClaimValid(): Promise<boolean> { return this.claimed; }
  async completeWorkerTask(): Promise<Task | undefined> { return this.claimed ? task : undefined; }
  async getExpiredWorkerTasks(): Promise<Task[]> { return []; }
  async getAssignedWorkerTasks(): Promise<Task[]> { return []; }
  async update(): Promise<Task | undefined> { return undefined; }
  async delete(): Promise<boolean> { return false; }
  async count(): Promise<number> { return 0; }
  async insertEvent(_event: AgentEvent): Promise<void> {}
  async getEventsByTaskId(): Promise<AgentEvent[]> { return []; }
  async deleteEventsByTaskId(): Promise<void> {}
  async getArchivedTasks(): Promise<Task[]> { return []; }
}

class FakeWorkerRepository implements WorkerRepository {
  readonly sessions: Array<{ taskId: string; sessionId: string; baseUrl: string; updatedAt: number }> = [];
  readonly commands = new Map<string, QueuedWorkerCommand[]>();

  async register(): Promise<Worker> { return worker; }
  async heartbeat(): Promise<Worker> { return worker; }
  async getById(): Promise<Worker | undefined> { return worker; }
  async getByTokenHash(): Promise<(Worker & { readonly tokenHash: string }) | undefined> {
    return { ...worker, tokenHash: crypto.createHash('sha256').update('worker-token').digest('hex') };
  }
  async list(): Promise<Worker[]> { return [worker]; }
  async markOffline(): Promise<Worker[]> { return []; }
  async registerTaskSession(taskId: string, sessionId: string, baseUrl: string, updatedAt: number): Promise<void> {
    this.sessions.push({ taskId, sessionId, baseUrl, updatedAt });
  }
  async getTaskSessions(taskId: string): Promise<readonly { sessionId: string; baseUrl: string; updatedAt: number }[]> {
    return this.sessions
      .filter((session) => session.taskId === taskId)
      .map(({ sessionId, baseUrl, updatedAt }) => ({ sessionId, baseUrl, updatedAt }));
  }
  async enqueueTaskCommand(taskId: string, command: QueuedWorkerCommand): Promise<void> {
    const list = this.commands.get(taskId) ?? [];
    list.push(command);
    this.commands.set(taskId, list);
  }
  async claimTaskCommands(taskId: string, limit: number): Promise<readonly QueuedWorkerCommand[]> {
    const list = this.commands.get(taskId) ?? [];
    const claimed = list.slice(0, limit);
    this.commands.set(taskId, list.slice(claimed.length));
    return claimed;
  }
  async clearTaskCommands(taskId: string): Promise<void> {
    this.commands.delete(taskId);
  }
}

async function withServer(callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/workers', createWorkersRouter(new FakeTaskRepository(), new FakeWorkerRepository()));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function workerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: 'Bearer worker-token', ...extra };
}

test('worker assignments and claim responses contain only story handoff fields', async () => {
  await withServer(async (baseUrl) => {
    const assignmentsResponse = await fetch(`${baseUrl}/api/workers/me/assignments`, { headers: workerHeaders() });
    assert.equal(assignmentsResponse.status, 200);
    const assignments = await assignmentsResponse.json() as { tasks: readonly Record<string, unknown>[] };
    assert.deepEqual(Object.keys(assignments.tasks[0] ?? {}).sort(), [
      'agentPreference', 'agentType', 'baseBranch', 'branchName', 'description', 'id', 'labels', 'priority', 'timeoutMinutes', 'title', 'useWorktree',
    ]);
    assert.deepEqual(assignments.tasks[0]?.labels, ['backend', 'urgent']);
    assert.equal(assignments.tasks[0]?.agentPreference, 'fast-coder');
    assert.equal('repoPath' in (assignments.tasks[0] ?? {}), false);
    assert.equal('worktreePath' in (assignments.tasks[0] ?? {}), false);
    assert.equal('projectId' in (assignments.tasks[0] ?? {}), false);

    const claimResponse = await fetch(`${baseUrl}/api/workers/me/tasks/task-1/claim`, {
      method: 'POST',
      headers: workerHeaders(),
    });
    assert.equal(claimResponse.status, 200);
    const claim = await claimResponse.json() as { task: Record<string, unknown> };
    assert.deepEqual(Object.keys(claim.task).sort(), [
      'agentPreference', 'agentType', 'baseBranch', 'branchName', 'description', 'id', 'labels', 'priority', 'timeoutMinutes', 'title', 'useWorktree',
    ]);
    assert.equal('repoPath' in claim.task, false);
    assert.equal('worktreePath' in claim.task, false);
    assert.equal('projectId' in claim.task, false);

    const completionResponse = await fetch(`${baseUrl}/api/workers/me/tasks/task-1/complete`, {
      method: 'POST',
      headers: { ...workerHeaders({ 'x-worker-claim': 'claim-token' }), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'complete' }),
    });
    assert.equal(completionResponse.status, 200);
    const completion = await completionResponse.json() as { task: Record<string, unknown> };
    assert.deepEqual(Object.keys(completion.task).sort(), [
      'agentPreference', 'agentType', 'baseBranch', 'branchName', 'description', 'id', 'labels', 'priority', 'timeoutMinutes', 'title', 'useWorktree',
    ]);
    assert.equal('repoPath' in completion.task, false);
    assert.equal('worktreePath' in completion.task, false);
    assert.equal('projectId' in completion.task, false);
  });
});

test('worker can register a task OpenCode session link and poll queued commands', async () => {
  const taskRepo = new FakeTaskRepository();
  const workerRepo = new FakeWorkerRepository();
  await withServer(async (baseUrl) => {
    const app = express();
    app.use(express.json());
    app.use('/api/workers', createWorkersRouter(taskRepo, workerRepo));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const localUrl = `http://127.0.0.1:${address.port}`;
    try {
      const claimResponse = await fetch(`${localUrl}/api/workers/me/tasks/task-1/claim`, {
        method: 'POST',
        headers: workerHeaders(),
      });
      assert.equal(claimResponse.status, 200);
      const claimBody = await claimResponse.json() as { claimToken: string };

      const registerSession = await fetch(`${localUrl}/api/workers/me/tasks/task-1/session`, {
        method: 'POST',
        headers: { ...workerHeaders({ 'x-worker-claim': claimBody.claimToken }), 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses_worker_1', baseUrl: 'http://127.0.0.1:4455/session/task-1' }),
      });
      assert.equal(registerSession.status, 200);
      const sessionBody = await registerSession.json() as { success: boolean };
      assert.equal(sessionBody.success, true);
      assert.deepEqual(workerRepo.sessions.map(({ taskId, sessionId, baseUrl }) => ({ taskId, sessionId, baseUrl })), [
        { taskId: 'task-1', sessionId: 'ses_worker_1', baseUrl: 'http://127.0.0.1:4455/session/task-1' },
      ]);

      await workerRepo.enqueueTaskCommand('task-1', {
        id: 'cmd-1',
        type: 'message',
        message: 'follow-up',
        createdAt: Date.now(),
      });

      const poll = await fetch(`${localUrl}/api/workers/me/tasks/task-1/commands`, {
        headers: workerHeaders({ 'x-worker-claim': claimBody.claimToken }),
      });
      assert.equal(poll.status, 200);
      const commandBody = await poll.json() as { commands: readonly QueuedWorkerCommand[] };
      assert.equal(commandBody.commands.length, 1);
      assert.equal(commandBody.commands[0]?.type, 'message');

      const pollAgain = await fetch(`${localUrl}/api/workers/me/tasks/task-1/commands`, {
        headers: workerHeaders({ 'x-worker-claim': claimBody.claimToken }),
      });
      assert.equal(pollAgain.status, 200);
      const commandBodyAgain = await pollAgain.json() as { commands: readonly QueuedWorkerCommand[] };
      assert.equal(commandBodyAgain.commands.length, 0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test('worker session registration rejects non-loopback OpenCode base URLs', async () => {
  const taskRepo = new FakeTaskRepository();
  const workerRepo = new FakeWorkerRepository();
  const app = express();
  app.use(express.json());
  app.use('/api/workers', createWorkersRouter(taskRepo, workerRepo));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const claimResponse = await fetch(`${baseUrl}/api/workers/me/tasks/task-1/claim`, {
      method: 'POST',
      headers: workerHeaders(),
    });
    assert.equal(claimResponse.status, 200);
    const claimBody = await claimResponse.json() as { claimToken: string };

    const registerSession = await fetch(`${baseUrl}/api/workers/me/tasks/task-1/session`, {
      method: 'POST',
      headers: { ...workerHeaders({ 'x-worker-claim': claimBody.claimToken }), 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'ses_worker_1', baseUrl: 'http://192.168.1.10:4096' }),
    });
    assert.equal(registerSession.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('worker session registration rejects bridge URLs with task ids that do not match the claimed task', async () => {
  const taskRepo = new FakeTaskRepository();
  const workerRepo = new FakeWorkerRepository();
  const app = express();
  app.use(express.json());
  app.use('/api/workers', createWorkersRouter(taskRepo, workerRepo));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const claimResponse = await fetch(`${baseUrl}/api/workers/me/tasks/task-1/claim`, {
      method: 'POST',
      headers: workerHeaders(),
    });
    assert.equal(claimResponse.status, 200);
    const claimBody = await claimResponse.json() as { claimToken: string };

    const registerSession = await fetch(`${baseUrl}/api/workers/me/tasks/task-1/session`, {
      method: 'POST',
      headers: { ...workerHeaders({ 'x-worker-claim': claimBody.claimToken }), 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'ses_worker_1', baseUrl: 'http://127.0.0.1:4455/session/task-2' }),
    });
    assert.equal(registerSession.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
