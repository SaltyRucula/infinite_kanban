import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import express from 'express';
import { createGroupsRouter } from '../src/routes/groups.js';
import type { Project, Task, TaskGroup } from '../src/types.js';
import type { TaskGroupRepository } from '../src/repositories/group-types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
import type { AgentManager } from '../src/services/agent-manager.js';

const project: Project = {
  id: 'default',
  name: 'Default',
  repoPath: '/project/repo',
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
  defaultAgentType: 'opencode',
  defaultPriority: 'medium',
  defaultBaseBranch: 'main',
  defaultUseWorktree: true,
  jiraImportEnabled: false,
  jiraImportIntervalMinutes: 15,
  jiraImportAutoStart: false,
};

function makeGroup(): TaskGroup {
  return {
    id: 'group-1',
    projectId: project.id,
    title: 'Group',
    priority: 'medium',
    columnId: 'backlog',
    maxConcurrency: 2,
    createdAt: 1,
  };
}

function makeChild(id: string, assignedWorkerId?: string): Task {
  return {
    id,
    projectId: project.id,
    title: id,
    description: '',
    priority: 'medium',
    columnId: 'backlog',
    agentStatus: 'idle',
    createdAt: 1,
    repoPath: '/server-only/repo',
    worktreePath: '/server-only/worktree',
    branchName: `group/${id}`,
    baseBranch: 'main',
    useWorktree: true,
    assignedWorkerId,
    groupId: 'group-1',
  };
}

interface Harness {
  readonly group: TaskGroup;
  readonly children: Task[];
  readonly created: { group?: TaskGroup; children?: readonly Omit<Task, 'columnId' | 'agentStatus' | 'createdAt'>[] };
  readonly requestedRuns: string[];
  readonly startGroupCalls: number;
}

function createHarness(initialChildren: readonly Task[] = [], groupId = 'group-1'): Harness {
  const state: Harness = {
    group: { ...makeGroup(), id: groupId },
    children: [...initialChildren],
    created: {},
    requestedRuns: [],
    startGroupCalls: 0,
  };

  const groupRepo: TaskGroupRepository = {
    async getAll(): Promise<TaskGroup[]> { return [state.group]; },
    async getById(id: string): Promise<TaskGroup | undefined> {
      return id === state.group.id ? state.group : undefined;
    },
    async create(group, children): Promise<{ group: TaskGroup; children: Task[] }> {
      state.created.group = group;
      state.created.children = children;
      state.group = group;
      state.children = children.map((child) => ({
        ...child,
        columnId: group.columnId,
        agentStatus: 'idle',
        createdAt: group.createdAt,
      }));
      return { group, children: state.children };
    },
    async update(_id, updates): Promise<TaskGroup | undefined> {
      state.group = { ...state.group, ...updates };
      return state.group;
    },
    async delete(): Promise<boolean> { return false; },
    async getChildTasks(): Promise<Task[]> { return state.children; },
  };

  const taskRepo: TaskRepository = {
    async getAll(): Promise<Task[]> { return state.children; },
    async getById(id: string): Promise<Task | undefined> { return state.children.find((child) => child.id === id); },
    async getByExternalIdentity(): Promise<Task | undefined> { return undefined; },
    async create(task: Task): Promise<Task> { return task; },
    async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> { return { task, created: true }; },
    async requestRun(id: string): Promise<Task | undefined> {
      state.requestedRuns.push(id);
      const child = state.children.find((candidate) => candidate.id === id);
      return child ? { ...child, runRequestedAt: 2 } : undefined;
    },
    async claimRun(): Promise<Task | undefined> { return undefined; },
    async clearRun(): Promise<Task | undefined> { return undefined; },
    async getPendingRuns(): Promise<Task[]> { return []; },
    async update(): Promise<Task | undefined> { return undefined; },
    async delete(): Promise<boolean> { return false; },
    async count(): Promise<number> { return state.children.length; },
    async insertEvent(): Promise<void> {},
    async getEventsByTaskId(): Promise<[]> { return []; },
    async deleteEventsByTaskId(): Promise<void> {},
    async getArchivedTasks(): Promise<Task[]> { return []; },
  };

  const agentManager = {
    isGroupRunning: () => false,
    stopGroup: async () => {},
    startGroup: () => { state.startGroupCalls += 1; },
    removeWorktree: () => {},
  } as unknown as AgentManager;

  const projectRepo: ProjectRepository = {
    async getAllWithCounts(): Promise<Project[]> { return [project]; },
    async getById(id: string): Promise<Project | undefined> { return id === project.id ? project : undefined; },
    async getDefault(): Promise<Project> { return project; },
    async resolve(): Promise<Project[]> { return [project]; },
    async create(): Promise<Project> { return project; },
    async update(): Promise<Project> { return project; },
    async delete(): Promise<boolean> { return false; },
    async hasTasksOrGroups(): Promise<boolean> { return false; },
  };

  const app = express();
  app.use(express.json());
  app.use('/api/groups', createGroupsRouter(groupRepo, taskRepo, agentManager, projectRepo));
  const server: Server = createServer(app);
  return Object.assign(state, { server });
}

async function withApp(
  harness: Harness & { readonly server: Server },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve) => harness.server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const address = harness.server.address();
    if (!address || typeof address === 'string') throw new Error('bind failed');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => harness.server.close((error) => error ? reject(error) : resolve()));
  }
}

test('group create rejects server-owned path fields in group and child payloads', async () => {
  const harness = createHarness();
  await withApp(harness, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Portable group',
        repoPath: '/client/repo',
        children: [
          { title: 'One', repoPath: '/client/repo' },
          { title: 'Two', worktreePath: '/client/worktree' },
        ],
      }),
    });
    assert.equal(response.status, 400);
    assert.match(String((await response.json()).error), /repoPath|worktreePath/);
  });
});

test('group create does not inherit project paths and returns portable children', async () => {
  const harness = createHarness();
  await withApp(harness, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Portable group', children: [{ title: 'One' }, { title: 'Two' }] }),
    });
    assert.equal(response.status, 201);
    assert.equal(harness.created.group?.repoPath, undefined);
    assert.equal(harness.created.children?.[0]?.repoPath, undefined);
    const body = await response.json();
    assert.equal('repoPath' in body, false);
    assert.equal('repoPath' in body.children[0], false);
    assert.equal('worktreePath' in body.children[0], false);
  });
});

test('group run requires worker assignment and never starts a server agent group', async () => {
  const harness = createHarness([makeChild('child-1')]);
  await withApp(harness, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/groups/group-1/run`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'all group children must have worker assignments' });
    assert.deepEqual(harness.requestedRuns, []);
    assert.equal(harness.startGroupCalls, 0);
  });
});

test('group run requests worker runs and returns portable child tasks', async () => {
  const harness = createHarness([makeChild('child-1', 'worker-1')], 'group-2');
  await withApp(harness, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/groups/group-2/run`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(harness.requestedRuns, ['child-1']);
    assert.equal(harness.startGroupCalls, 0);
    const body = await response.json();
    assert.equal('repoPath' in body, false);
    assert.equal('repoPath' in body.children[0], false);
    assert.equal('worktreePath' in body.children[0], false);
  });
});
