import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Task, TaskGroup } from '../src/types.js';
import {
  getAllTasksAcrossProjects,
  getAllGroupsAcrossProjects,
} from '../src/startup-recovery.js';

function makeProject(id: string): Project {
  return { id, name: id, isDefault: id === 'default', createdAt: 1, updatedAt: 1 };
}

function makeTask(id: string, projectId: string): Task {
  return {
    id,
    projectId,
    title: id,
    description: '',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'executing',
    createdAt: 1,
  };
}

function makeGroup(id: string, projectId: string): TaskGroup {
  return {
    id,
    title: id,
    priority: 'medium',
    columnId: 'in-progress',
    maxConcurrency: 1,
    createdAt: 1,
    projectId,
  };
}

test('getAllTasksAcrossProjects collects orphaned tasks from every project, not just default', async () => {
  const projectRepo = {
    async getAllWithCounts(): Promise<Project[]> {
      return [makeProject('default'), makeProject('tellurium'), makeProject('infra')];
    },
  };
  const tasksByProject = new Map<string, Task[]>([
    ['default', []],
    ['tellurium', [makeTask('t1', 'tellurium')]],
    ['infra', [makeTask('t2', 'infra')]],
  ]);
  const taskRepo = {
    async getAll(_includeArchived: boolean, projectId = 'default'): Promise<Task[]> {
      return tasksByProject.get(projectId) ?? [];
    },
  };

  const all = await getAllTasksAcrossProjects(projectRepo, taskRepo);
  assert.deepEqual(all.map((t) => t.id).sort(), ['t1', 't2']);
});

test('getAllGroupsAcrossProjects collects in-progress groups from every project, not just default', async () => {
  const projectRepo = {
    async getAllWithCounts(): Promise<Project[]> {
      return [makeProject('default'), makeProject('tellurium')];
    },
  };
  const groupsByProject = new Map<string, TaskGroup[]>([
    ['default', []],
    ['tellurium', [makeGroup('g1', 'tellurium')]],
  ]);
  const groupRepo = {
    async getAll(_includeArchived: boolean, projectId = 'default'): Promise<TaskGroup[]> {
      return groupsByProject.get(projectId) ?? [];
    },
  };

  const all = await getAllGroupsAcrossProjects(projectRepo, groupRepo);
  assert.deepEqual(all.map((g) => g.id), ['g1']);
});
