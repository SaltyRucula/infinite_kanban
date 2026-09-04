import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import express from 'express';
import { createGroupsRouter } from '../src/routes/groups.js';
import type { Task, TaskGroup, Project } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { TaskGroupRepository } from '../src/repositories/group-types.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
import type { AgentManager } from '../src/services/agent-manager.js';

function makeProject(): Project {
  return {
    id: 'default',
    name: 'Default',
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
    jiraImportEnabled: false,
    jiraImportIntervalMinutes: 15,
    jiraImportAutoStart: false,
  };
}

function makeGroup(): TaskGroup {
  return {
    id: 'group-1',
    projectId: 'default',
    title: 'Group',
    priority: 'medium',
    columnId: 'backlog',
    maxConcurrency: 2,
    createdAt: 1,
  };
}

function createGroupRepo(group: TaskGroup): TaskGroupRepository {
  const current = { ...group };
  return {
    async getAll(): Promise<TaskGroup[]> { return [current]; },
    async getById(id: string): Promise<TaskGroup | undefined> { return id === current.id ? current : undefined; },
    async create(next, _children): Promise<{ group: TaskGroup; children: Task[] }> { return { group: next, children: [] }; },
    async update(): Promise<TaskGroup | undefined> { return current; },
    async delete(): Promise<boolean> { return false; },
    async getChildTasks(): Promise<Task[]> { return []; },
    async updateChildTaskOrder(): Promise<void> {},
  };
}

function createTaskRepo(): TaskRepository {
  return {
    async getAll(): Promise<Task[]> { return []; },
    async getById(): Promise<Task | undefined> { return undefined; },
    async getByExternalIdentity(): Promise<Task | undefined> { return undefined; },
    async create(task: Task): Promise<Task> { return task; },
    async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> { return { task, created: true }; },
    async requestRun(): Promise<Task | undefined> { return undefined; },
    async claimRun(): Promise<Task | undefined> { return undefined; },
    async clearRun(): Promise<Task | undefined> { return undefined; },
    async getPendingRuns(): Promise<Task[]> { return []; },
    async update(): Promise<Task | undefined> { return undefined; },
    async delete(): Promise<boolean> { return false; },
    async count(): Promise<number> { return 0; },
    async insertEvent(): Promise<void> {},
    async getEventsByTaskId(): Promise<[]> { return []; },
    async deleteEventsByTaskId(): Promise<void> {},
    async getArchivedTasks(): Promise<Task[]> { return []; },
  };
}

function createProjectRepo(project: Project): ProjectRepository {
  return {
    async getAllWithCounts(): Promise<Project[]> { return [project]; },
    async getById(id: string): Promise<Project | undefined> { return id === project.id ? project : undefined; },
    async getDefault(): Promise<Project | undefined> { return project; },
    async resolve(): Promise<Project[]> { return [project]; },
    async create(): Promise<Project> { return project; },
    async update(): Promise<Project | undefined> { return project; },
    async delete(): Promise<boolean> { return false; },
    async hasTasksOrGroups(): Promise<boolean> { return false; },
  };
}

function createManager(): AgentManager {
  return {
    isGroupRunning: () => false,
    stopGroup: async () => {},
    startGroup: () => {},
    removeWorktree: () => {},
  } as unknown as AgentManager;
}

async function withApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/groups', createGroupsRouter(createGroupRepo(makeGroup()), createTaskRepo(), createManager(), createProjectRepo(makeProject())));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('bind failed');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

test('PATCH /api/groups/:id rejects pending column', async () => {
  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/groups/group-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ columnId: 'pending' }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(String(body.error), /task groups cannot be moved to pending/i);
  });
});
