import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { MAX_GROUP_CHILDREN, MAX_PENDING_WORK_REQUESTS } from '@ai-agent-board/shared/constants.js';
import { createTaskRouter } from '../src/routes/tasks.js';
import { createWorkersRouter } from '../src/routes/workers.js';
import type { AgentEvent, Task, TaskGroup, Worker } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { WorkerRepository } from '../src/repositories/worker-types.js';
import type { TaskGroupRepository } from '../src/repositories/group-types.js';

const WORKER_TOKEN = 'worker-token';

const worker: Worker = {
  id: 'worker-1',
  name: 'worker',
  status: 'online',
  agentTypes: ['codex'],
  maxConcurrentTasks: 1,
  registeredAt: Date.now(),
  lastHeartbeatAt: Date.now(),
  updatedAt: Date.now(),
};

const origin: Task = {
  id: 'origin-task',
  title: 'Origin task',
  description: 'A running worker proposes follow-up work.',
  priority: 'high',
  columnId: 'in-progress',
  agentStatus: 'executing',
  createdAt: 1,
  projectId: 'project-a',
  agentType: 'codex',
  labels: [],
  assignedWorkerId: worker.id,
};

function makeGroup(overrides: Partial<TaskGroup> = {}): TaskGroup {
  return {
    id: 'group-a',
    projectId: 'project-a',
    title: 'Release hardening',
    priority: 'medium',
    columnId: 'backlog',
    maxConcurrency: 1,
    createdAt: 1,
    ...overrides,
  };
}

/** In-memory store shared by the worker ingress and the task routes. */
class Store {
  readonly tasks = new Map<string, Task>([[origin.id, origin]]);
  readonly events: AgentEvent[] = [];
  readonly groups = new Map<string, TaskGroup>();
  private eventReadsToBlock = 0;
  private eventReadGate?: Promise<void>;
  private releaseEventReadGate?: () => void;
  private eventReadsBlocked?: () => void;

  blockEventReads(count: number): Promise<void> {
    this.eventReadsToBlock = count;
    this.eventReadGate = new Promise((resolve) => { this.releaseEventReadGate = resolve; });
    return new Promise((resolve) => { this.eventReadsBlocked = resolve; });
  }

  releaseBlockedEventReads(): void {
    this.releaseEventReadGate?.();
  }

  private async eventsForTask(taskId: string): Promise<AgentEvent[]> {
    if (this.eventReadsToBlock > 0) {
      this.eventReadsToBlock -= 1;
      if (this.eventReadsToBlock === 0) this.eventReadsBlocked?.();
      await this.eventReadGate;
    }
    return this.events.filter((event) => event.taskId === taskId);
  }

  taskRepo(): TaskRepository {
    return {
      getById: async (id: string) => this.tasks.get(id),
      getEventsByTaskId: async (taskId: string) => this.eventsForTask(taskId),
      insertEvent: async (event: AgentEvent) => { this.events.push(event); },
      insertWorkRequestIfBelowPendingLimit: async (event: AgentEvent, _projectId: string, limit: number) => {
        if (storedRequests(this).length >= limit) return false;
        this.events.push(event);
        return true;
      },
      getByExternalIdentity: async (projectId: string, source: string, key: string) => [...this.tasks.values()]
        .find((task) => task.projectId === projectId && task.externalSource === source && task.externalKey === key),
      createIdempotent: async (task: Task) => {
        const existing = [...this.tasks.values()].find((candidate) => candidate.projectId === task.projectId
          && candidate.externalSource === task.externalSource && candidate.externalKey === task.externalKey);
        if (existing) return { task: existing, created: false };
        this.tasks.set(task.id, task);
        return { task, created: true };
      },
      createIdempotentInGroup: async (task: Task, maxChildren: number) => {
        const existing = [...this.tasks.values()].find((candidate) => candidate.projectId === task.projectId
          && candidate.externalSource === task.externalSource && candidate.externalKey === task.externalKey);
        if (existing) return { task: existing, created: false, groupFull: false };
        const children = [...this.tasks.values()].filter((candidate) => candidate.groupId === task.groupId);
        if (children.length >= maxChildren) return { task: undefined, created: false, groupFull: true };
        const groupOrder = children.reduce((max, child) => Math.max(max, (child.groupOrder ?? -1) + 1), children.length);
        const created = { ...task, groupOrder };
        this.tasks.set(created.id, created);
        return { task: created, created: true, groupFull: false };
      },
      isWorkerClaimValid: async () => true,
      renewWorkerLease: async () => true,
      requestRun: async () => { throw new Error('approval must never request a run'); },
    } as unknown as TaskRepository;
  }

  groupRepo(): TaskGroupRepository {
    return {
      getById: async (id: string) => this.groups.get(id),
      getChildTasks: async (groupId: string) => [...this.tasks.values()].filter((task) => task.groupId === groupId),
    } as unknown as TaskGroupRepository;
  }
}

const workerRepo = {
  getByTokenHash: async () => ({ ...worker, tokenHash: crypto.createHash('sha256').update(WORKER_TOKEN).digest('hex') }),
} as unknown as WorkerRepository;

async function withServer(store: Store, callback: (baseUrl: string) => Promise<void>, running = new Set<string>()): Promise<void> {
  const projects = {
    getById: async (id: string) => ({ id, name: id, isDefault: false }),
    getDefault: async () => ({ id: 'default', name: 'Default', isDefault: true }),
  };
  const manager = {
    isRunning: () => false,
    isGroupRunning: (groupId: string) => running.has(groupId),
    stopAgent: () => {},
    clearEvents: () => {},
    startAgent: () => { throw new Error('approval must never start an agent'); },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/workers', createWorkersRouter(store.taskRepo(), workerRepo));
  app.use('/api/tasks', createTaskRouter(store.taskRepo(), manager as any, projects as any, undefined, store.groupRepo()));
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

async function postWorkRequest(baseUrl: string, n: number): Promise<Response> {
  return fetch(`${baseUrl}/api/workers/me/tasks/${origin.id}/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${WORKER_TOKEN}`,
      'x-worker-claim': 'claim-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      taskId: origin.id,
      type: 'request_work',
      content: `Requesting follow-up ${n}`,
      timestamp: Date.now(),
      metadata: { workRequest: { title: `Follow-up ${n}`, description: `Details ${n}`, agentType: 'codex' } },
    }),
  });
}

function storedRequests(store: Store): AgentEvent[] {
  return store.events.filter((event) => event.type === 'request_work');
}

function approve(baseUrl: string, eventId: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${baseUrl}/api/tasks/${origin.id}/work-requests/${eventId}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function fillToCap(store: Store, baseUrl: string): Promise<void> {
  for (let i = 0; i < MAX_PENDING_WORK_REQUESTS; i += 1) {
    const response = await postWorkRequest(baseUrl, i);
    assert.equal(response.status, 200, `request ${i} within the cap should be accepted`);
  }
  assert.equal(storedRequests(store).length, MAX_PENDING_WORK_REQUESTS);
}

test('worker ingress rejects work requests over the pending cap without storing them', async () => {
  const store = new Store();
  await withServer(store, async (baseUrl) => {
    await fillToCap(store, baseUrl);

    const rejected = await postWorkRequest(baseUrl, 99);
    assert.equal(rejected.status, 409);
    const body = await rejected.json() as { error: string };
    assert.match(body.error, /too many pending work requests/);
    assert.equal(storedRequests(store).length, MAX_PENDING_WORK_REQUESTS);

    // Non-proposal events are unaffected by the cap.
    const output = await fetch(`${baseUrl}/api/workers/me/tasks/${origin.id}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WORKER_TOKEN}`, 'x-worker-claim': 'claim-token', 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: origin.id, type: 'output', content: 'still working', timestamp: Date.now() }),
    });
    assert.equal(output.status, 200);
  });
});

test('concurrent worker ingress never exceeds the pending work-request cap', async () => {
  const store = new Store();
  await withServer(store, async (baseUrl) => {
    for (let i = 0; i < MAX_PENDING_WORK_REQUESTS - 1; i += 1) {
      assert.equal((await postWorkRequest(baseUrl, i)).status, 200);
    }
    const responses = await Promise.all([postWorkRequest(baseUrl, 100), postWorkRequest(baseUrl, 101)]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal(storedRequests(store).length, MAX_PENDING_WORK_REQUESTS);
  });
});

test('worker ingress rejects a request_work event without a structured proposal', async () => {
  const store = new Store();
  await withServer(store, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/workers/me/tasks/${origin.id}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WORKER_TOKEN}`, 'x-worker-claim': 'claim-token', 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: origin.id, type: 'request_work', content: 'no proposal', timestamp: Date.now() }),
    });
    assert.equal(response.status, 400);
    assert.equal(store.events.length, 0);
  });
});

test('approving a pending work request frees a slot under the cap', async () => {
  const store = new Store();
  await withServer(store, async (baseUrl) => {
    await fillToCap(store, baseUrl);
    assert.equal((await postWorkRequest(baseUrl, 98)).status, 409);

    const approved = await approve(baseUrl, storedRequests(store)[0]!.id);
    assert.equal(approved.status, 201);

    assert.equal((await postWorkRequest(baseUrl, 100)).status, 200);
    assert.equal((await postWorkRequest(baseUrl, 101)).status, 409);
  });
});

test('dismissing a pending work request frees a slot under the cap', async () => {
  const store = new Store();
  await withServer(store, async (baseUrl) => {
    await fillToCap(store, baseUrl);
    assert.equal((await postWorkRequest(baseUrl, 98)).status, 409);

    const dismissed = await fetch(`${baseUrl}/api/tasks/${origin.id}/work-requests/${storedRequests(store)[0]!.id}/dismiss`, { method: 'POST' });
    assert.equal(dismissed.status, 204);

    assert.equal((await postWorkRequest(baseUrl, 100)).status, 200);
    assert.equal((await postWorkRequest(baseUrl, 101)).status, 409);
  });
});

test('approving into a valid group places the task in that group without running it', async () => {
  const store = new Store();
  store.groups.set('group-a', makeGroup());
  store.tasks.set('existing-child', {
    ...origin, id: 'existing-child', assignedWorkerId: undefined, columnId: 'backlog', agentStatus: 'idle', groupId: 'group-a', groupOrder: 0,
  });
  await withServer(store, async (baseUrl) => {
    assert.equal((await postWorkRequest(baseUrl, 1)).status, 200);
    const eventId = storedRequests(store)[0]!.id;

    const response = await approve(baseUrl, eventId, { groupId: 'group-a' });
    assert.equal(response.status, 201);
    const created = await response.json() as Task;
    assert.equal(created.groupId, 'group-a');
    assert.equal(created.groupOrder, 1);
    assert.equal(created.columnId, 'backlog');
    assert.equal(created.agentStatus, 'idle');
    assert.equal(created.projectId, origin.projectId);
    assert.equal(store.tasks.get(created.id)?.runRequestedAt, undefined);

    // Idempotent replay returns the same task and creates nothing new.
    const replay = await approve(baseUrl, eventId, { groupId: 'group-a' });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as Task).id, created.id);
    assert.equal([...store.tasks.values()].filter((task) => task.groupId === 'group-a').length, 2);
  });
});

test('concurrent approvals cannot overfill a group or reuse its group order', async () => {
  const store = new Store();
  store.groups.set('group-a', makeGroup());
  for (let i = 0; i < MAX_GROUP_CHILDREN - 1; i += 1) {
    store.tasks.set(`existing-child-${i}`, {
      ...origin, id: `existing-child-${i}`, assignedWorkerId: undefined, columnId: 'backlog', agentStatus: 'idle', groupId: 'group-a', groupOrder: i,
    });
  }
  await withServer(store, async (baseUrl) => {
    assert.equal((await postWorkRequest(baseUrl, 1)).status, 200);
    assert.equal((await postWorkRequest(baseUrl, 2)).status, 200);
    const responses = await Promise.all(storedRequests(store).map((event) => approve(baseUrl, event.id, { groupId: 'group-a' })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    const children = [...store.tasks.values()].filter((task) => task.groupId === 'group-a');
    assert.equal(children.length, MAX_GROUP_CHILDREN);
    assert.deepEqual(children.map((task) => task.groupOrder).sort((a, b) => a! - b!), Array.from({ length: MAX_GROUP_CHILDREN }, (_, index) => index));
  });
});

test('approving into a missing group is rejected and creates no task', async () => {
  const store = new Store();
  await withServer(store, async (baseUrl) => {
    assert.equal((await postWorkRequest(baseUrl, 1)).status, 200);
    const response = await approve(baseUrl, storedRequests(store)[0]!.id, { groupId: 'no-such-group' });
    assert.equal(response.status, 404);
    assert.match((await response.json() as { error: string }).error, /group not found/);
    assert.equal(store.tasks.size, 1);
  });
});

test('approving into a group of another project is rejected and creates no task', async () => {
  const store = new Store();
  store.groups.set('group-b', makeGroup({ id: 'group-b', projectId: 'project-b' }));
  await withServer(store, async (baseUrl) => {
    assert.equal((await postWorkRequest(baseUrl, 1)).status, 200);
    const response = await approve(baseUrl, storedRequests(store)[0]!.id, { groupId: 'group-b' });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /different project/);
    assert.equal(store.tasks.size, 1);
  });
});

test('approving into a started, running, or archived group is rejected', async () => {
  const store = new Store();
  store.groups.set('started', makeGroup({ id: 'started', columnId: 'in-progress' }));
  store.groups.set('running', makeGroup({ id: 'running' }));
  store.groups.set('archived', makeGroup({ id: 'archived', archived: true }));
  await withServer(store, async (baseUrl) => {
    assert.equal((await postWorkRequest(baseUrl, 1)).status, 200);
    const eventId = storedRequests(store)[0]!.id;
    for (const groupId of ['started', 'running', 'archived']) {
      const response = await approve(baseUrl, eventId, { groupId });
      assert.equal(response.status, 409, `group ${groupId} should not accept new children`);
    }
    assert.equal(store.tasks.size, 1);
  }, new Set(['running']));
});
