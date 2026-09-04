import fs from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { API, prepareTestRepo, waitForBoard } from './helpers';

const CLARIFICATION_PROMPT = 'Which branch should I target?';
const CLARIFICATION_CHOICE = 'main';
const FAKE_JIRA_PORT = 3909;
const SCREENSHOT_FILE = path.resolve(
  process.cwd(),
  '../../.omo/evidence/jira-assigned-agent-automation/clarification-visible.png',
);

type ProjectRecord = {
  readonly id: string;
};

type TaskStatusRecord = {
  readonly id: string;
  readonly agentStatus: string;
  readonly agentType: string;
  readonly columnId: string;
  readonly isRunning: boolean;
};

type ClarificationRequestRecord = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly choices?: readonly string[];
};

type ClarificationAnswerRecord = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly answer: string;
};

type TaskRecord = {
  readonly id: string;
  readonly title: string;
  readonly columnId: string;
  readonly agentType: string;
  readonly agentStatus: string;
  readonly projectId: string;
  readonly externalSource?: string;
  readonly externalKey?: string;
  readonly clarificationRequest?: ClarificationRequestRecord | null;
  readonly clarificationAnswer?: ClarificationAnswerRecord | null;
};

type JiraImportResponse = {
  readonly total: number;
  readonly created: number;
  readonly skipped: number;
  readonly tasks: readonly TaskRecord[];
};

type JiraSearchPayload = {
  readonly jql?: string;
  readonly startAt?: number;
  readonly maxResults?: number;
};

async function readRequestJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function startFakeJiraServer(observations: { searchCalls: number; lastJql: string | null }): Promise<() => Promise<void>> {
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/rest/api/2/search') {
      observations.searchCalls += 1;
      const payload = await readRequestJson(req) as JiraSearchPayload;
      observations.lastJql = typeof payload.jql === 'string' ? payload.jql : null;

      sendJson(res, {
        startAt: payload.startAt ?? 0,
        total: 1,
        issues: [
          {
            id: '10001',
            key: 'PROJ-10001',
            fields: {
              summary: 'Auto-start imported task',
              description: 'Execute and ask clarification only when blocked',
              status: {
                name: 'To Do',
                statusCategory: { key: 'new' },
              },
              priority: { name: 'High' },
              issuetype: { name: 'Task' },
              project: { key: 'PROJ', name: 'Demo Project' },
              created: new Date().toISOString(),
              updated: new Date().toISOString(),
            },
          },
        ],
      });
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(FAKE_JIRA_PORT, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
}

async function waitForTaskStatus(
  request: APIRequestContext,
  taskId: string,
  predicate: (status: TaskStatusRecord) => boolean,
  timeoutMs: number,
): Promise<TaskStatusRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request.get(`${API}/api/tasks/${taskId}/status`);
    expect(response.status()).toBe(200);
    const status = await response.json() as TaskStatusRecord;
    if (predicate(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`timed out waiting for task ${taskId} status`);
}

async function getTaskById(request: APIRequestContext, projectId: string, taskId: string): Promise<TaskRecord> {
  const response = await request.get(`${API}/api/tasks?projectId=${projectId}`);
  expect(response.status()).toBe(200);
  const tasks = await response.json() as TaskRecord[];
  const task = tasks.find((candidate) => candidate.id === taskId);
  expect(task).toBeTruthy();
  return task as TaskRecord;
}

test.describe('F3 Jira assigned issue automation chain', () => {
  test('imports assigned Jira issue, auto-starts durable run, pauses for clarification, resumes same session, and completes', async ({ page, request }) => {
    const repoPath = prepareTestRepo(`jira-assigned-f3-${Date.now()}`, { clean: true });
    const projectName = `F3 Jira Automation ${Date.now()}`;
    const jiraObservations = { searchCalls: 0, lastJql: null as string | null };
    let projectId: string | null = null;
    let taskId: string | null = null;
    const stopFakeJira = await startFakeJiraServer(jiraObservations);

    try {
      const createProjectResponse = await request.post(`${API}/api/projects`, {
        data: {
          name: projectName,
          repoPath,
          defaultAgentType: 'opencode',
          jiraImportEnabled: false,
          jiraImportIntervalMinutes: 15,
          jiraImportAutoStart: true,
        },
      });
      expect(createProjectResponse.status()).toBe(201);
      const createdProject = await createProjectResponse.json() as ProjectRecord;
      projectId = createdProject.id;

      const importResponse = await request.post(`${API}/api/jira/import-assigned`, {
        data: { projectId },
      });
      expect(importResponse.status()).toBe(200);
      const importBody = await importResponse.json() as JiraImportResponse;
      expect(importBody.total).toBe(1);
      expect(importBody.created).toBe(1);
      expect(importBody.skipped).toBe(0);
      expect(importBody.tasks).toHaveLength(1);

      const importedTask = importBody.tasks[0];
      taskId = importedTask.id;
      expect(importedTask.projectId).toBe(projectId);
      expect(importedTask.columnId).toBe('backlog');
      expect(importedTask.agentType).toBe('opencode');
      expect(importedTask.externalSource).toBe('jira');
      expect(importedTask.externalKey).toContain('http://127.0.0.1:3909::10001');
      expect(jiraObservations.searchCalls).toBeGreaterThan(0);
      expect(jiraObservations.lastJql).toContain('assignee = currentUser()');

      const awaitingStatus = await waitForTaskStatus(
        request,
        taskId,
        (status) => status.agentStatus === 'awaiting_clarification',
        15_000,
      );
      expect(awaitingStatus.isRunning).toBe(true);

      const awaitingTask = await getTaskById(request, projectId, taskId);
      const clarificationRequest = awaitingTask.clarificationRequest;
      expect(clarificationRequest).toBeTruthy();
      expect(clarificationRequest?.prompt).toBe(CLARIFICATION_PROMPT);
      expect(clarificationRequest?.choices).toEqual(['main', 'develop']);
      expect(typeof clarificationRequest?.requestId).toBe('string');
      expect(typeof clarificationRequest?.sessionId).toBe('string');

      await page.goto(`/projects/${projectId}/tasks/${taskId}`);
      await waitForBoard(page);
      await expect(page.getByRole('heading', { name: importedTask.title, exact: true })).toBeVisible();
      await expect(page.getByTestId('clarification-card')).toBeVisible();
      await expect(page.getByTestId('clarification-prompt')).toHaveText(CLARIFICATION_PROMPT);

      fs.mkdirSync(path.dirname(SCREENSHOT_FILE), { recursive: true });
      await page.screenshot({ path: SCREENSHOT_FILE, fullPage: true });

      await page.getByRole('button', { name: CLARIFICATION_CHOICE, exact: true }).click();
      await expect(page.getByText(`Submitted: ${CLARIFICATION_CHOICE}`)).toBeVisible();

      const completedStatus = await waitForTaskStatus(
        request,
        taskId,
        (status) => status.agentStatus === 'complete',
        15_000,
      );
      expect(completedStatus.isRunning).toBe(false);

      const completedTask = await getTaskById(request, projectId, taskId);
      expect(completedTask.agentStatus).toBe('complete');
      expect(completedTask.clarificationAnswer?.requestId).toBe(clarificationRequest?.requestId);
      expect(completedTask.clarificationAnswer?.sessionId).toBe(clarificationRequest?.sessionId);
      expect(completedTask.clarificationAnswer?.answer).toBe(CLARIFICATION_CHOICE);

      console.log(
        `[f3-e2e] final taskId=${taskId} agentStatus=${completedStatus.agentStatus} sessionId=${clarificationRequest?.sessionId}`,
      );
    } finally {
      await stopFakeJira();
      if (taskId) {
        await request.post(`${API}/api/tasks/${taskId}/stop`).catch(() => undefined);
        await request.delete(`${API}/api/tasks/${taskId}`).catch(() => undefined);
      }
      if (projectId) {
        await request.delete(`${API}/api/projects/${projectId}`).catch(() => undefined);
      }
    }
  });
});
