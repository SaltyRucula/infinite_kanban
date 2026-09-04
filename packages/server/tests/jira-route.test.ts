import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import express from 'express';
import { createJiraRouter } from '../src/routes/jira.js';
import { JiraClientError } from '../src/jira/client.js';
import {
  JiraImportConflictError,
  JiraImportNotConfiguredError,
  type JiraImportExecutor,
} from '../src/jira/import-execution.js';
import type { Project } from '../src/types.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project 1',
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    jiraImportEnabled: true,
    jiraImportIntervalMinutes: 15,
    ...overrides,
  };
}

function createProjectRepository(projects: ReadonlyArray<Project>): ProjectRepository {
  return {
    async getAllWithCounts(): Promise<Project[]> {
      return [...projects];
    },
    async getById(id: string): Promise<Project | undefined> {
      return projects.find((project) => project.id === id);
    },
    async getDefault(): Promise<Project | undefined> {
      return projects.find((project) => project.isDefault) ?? projects[0];
    },
    async resolve(): Promise<Project[]> {
      return [...projects];
    },
    async create(): Promise<Project> {
      if (projects.length === 0) {
        throw new Error('project unavailable');
      }
      return projects[0];
    },
    async update(): Promise<Project | undefined> {
      return projects[0];
    },
    async hasTasksOrGroups(): Promise<boolean> {
      return false;
    },
    async delete(): Promise<boolean> {
      return false;
    },
  };
}

async function withJiraApp(
  projectRepo: ProjectRepository,
  executor: JiraImportExecutor,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/jira', createJiraRouter(projectRepo, executor));

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('failed to bind test server');
    }
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function postImportAssigned(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/jira/import-assigned`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('createJiraRouter returns Jira import result and manual trigger path on success', async () => {
  const project = makeProject();
  let trigger: string | undefined;
  const expectedResult = { total: 3, created: 2, skipped: 1, tasks: [] };

  const executor: JiraImportExecutor = {
    async executeProjectImport(_project, importTrigger) {
      trigger = importTrigger;
      return { status: 'completed', result: expectedResult };
    },
    async awaitIdle() {
      return true;
    },
  };

  await withJiraApp(createProjectRepository([project]), executor, async (baseUrl) => {
    const response = await postImportAssigned(baseUrl, {});
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(json, expectedResult);
    assert.equal(trigger, 'manual');
  });
});

test('createJiraRouter maps skipped overlap outcome to 409 conflict', async () => {
  const project = makeProject();
  const executor: JiraImportExecutor = {
    async executeProjectImport() {
      return { status: 'skipped_overlap' };
    },
    async awaitIdle() {
      return true;
    },
  };

  await withJiraApp(createProjectRepository([project]), executor, async (baseUrl) => {
    const response = await postImportAssigned(baseUrl, {});
    const json = await response.json();

    assert.equal(response.status, 409);
    assert.deepEqual(json, { error: 'Jira import already running for this project.' });
  });
});

test('createJiraRouter uses explicit projectId over default and falls back when omitted', async () => {
  const defaultProject = makeProject({ id: 'project-default', isDefault: true });
  const alternateProject = makeProject({ id: 'project-alternate', isDefault: false });
  const capturedProjects: Project[] = [];
  const triggers: string[] = [];
  const executor: JiraImportExecutor = {
    async executeProjectImport(project, importTrigger) {
      capturedProjects.push(project);
      triggers.push(importTrigger);
      return { status: 'completed', result: { total: 0, created: 0, skipped: 0, tasks: [] } };
    },
    async awaitIdle() {
      return true;
    },
  };

  await withJiraApp(createProjectRepository([defaultProject, alternateProject]), executor, async (baseUrl) => {
    const explicitResponse = await postImportAssigned(baseUrl, { projectId: alternateProject.id });
    const explicitJson = await explicitResponse.json();
    const defaultResponse = await postImportAssigned(baseUrl, {});
    const defaultJson = await defaultResponse.json();

    assert.equal(explicitResponse.status, 200);
    assert.deepEqual(explicitJson, { total: 0, created: 0, skipped: 0, tasks: [] });
    assert.equal(defaultResponse.status, 200);
    assert.deepEqual(defaultJson, { total: 0, created: 0, skipped: 0, tasks: [] });
    assert.deepEqual(capturedProjects.map((project) => project.id), [alternateProject.id, defaultProject.id]);
    assert.deepEqual(triggers, ['manual', 'manual']);
  });
});

test('createJiraRouter rejects invalid project id', async () => {
  const project = makeProject();
  const executor: JiraImportExecutor = {
    async executeProjectImport() {
      return { status: 'completed', result: { total: 0, created: 0, skipped: 0, tasks: [] } };
    },
    async awaitIdle() {
      return true;
    },
  };

  await withJiraApp(createProjectRepository([project]), executor, async (baseUrl) => {
    const response = await postImportAssigned(baseUrl, { projectId: 'does-not-exist' });
    const json = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(json, { error: 'projectId is invalid' });
  });
});

test('createJiraRouter maps conflict, not configured, and Jira client failures to safe status codes', async () => {
  const project = makeProject();
  const cases: ReadonlyArray<{
    readonly error: Error;
    readonly expectedStatus: number;
    readonly expectedBody: { readonly error: string };
  }> = [
    {
      error: new JiraImportConflictError('Jira import already running for this project.'),
      expectedStatus: 409,
      expectedBody: { error: 'Jira import already running for this project.' },
    },
    {
      error: new JiraImportNotConfiguredError('Jira import is not configured. Missing JIRA_BASE_URL.'),
      expectedStatus: 503,
      expectedBody: { error: 'Jira import is not configured. Missing JIRA_BASE_URL.' },
    },
    {
      error: new JiraClientError('auth', 'upstream auth error'),
      expectedStatus: 502,
      expectedBody: { error: 'Jira authentication failed.' },
    },
    {
      error: new JiraClientError('invalid_response', 'bad json'),
      expectedStatus: 502,
      expectedBody: { error: 'Jira returned an invalid response.' },
    },
    {
      error: new JiraClientError('upstream', 'status 500'),
      expectedStatus: 502,
      expectedBody: { error: 'Jira request failed.' },
    },
  ];

  for (const scenario of cases) {
    const executor: JiraImportExecutor = {
      async executeProjectImport() {
        throw scenario.error;
      },
      async awaitIdle() {
        return true;
      },
    };

    await withJiraApp(createProjectRepository([project]), executor, async (baseUrl) => {
      const response = await postImportAssigned(baseUrl, {});
      const json = await response.json();
      assert.equal(response.status, scenario.expectedStatus);
      assert.deepEqual(json, scenario.expectedBody);
    });
  }
});
