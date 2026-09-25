import { expect, test, type Page, type Route } from '@playwright/test';
import { waitForBoard } from './helpers';

const TASK_ID = 'task-clarification-ui';
const REQUEST_ID = 'req-clarification-1';
const SESSION_ID = 'session-clarification-1';
const PROMPT = 'Which implementation path should we take for parsing uploaded archives?';
const CHOICES = ['Use native unzip utility', 'Use JS zip library'];

type ResumeCall = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly answer: string;
};

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function maybeContinue(route: Route): Promise<void> {
  try {
    await route.continue();
  } catch {
    await route.fulfill({ status: 204, contentType: 'application/json', body: 'null' });
  }
}

async function mockClarificationBoard(
  page: Page,
  taskOverrides: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
  calls: ResumeCall[],
): Promise<void> {
  const baseTask = {
    id: TASK_ID,
    title: 'Clarification UI task',
    description: 'Render and submit clarification prompt from persisted task/events state',
    priority: 'high',
    columnId: 'in-progress',
    agentStatus: 'awaiting_clarification',
    createdAt: Date.now() - 60_000,
    projectId: 'default',
    agentType: 'opencode',
    clarificationRequest: {
      requestId: REQUEST_ID,
      sessionId: SESSION_ID,
      prompt: PROMPT,
      choices: CHOICES,
      timestamp: Date.now() - 5_000,
    },
    clarificationAnswer: null,
  };

  const project = {
    id: 'default',
    name: 'Default',
    isDefault: true,
    createdAt: Date.now() - 120_000,
    updatedAt: Date.now() - 120_000,
    jiraImportEnabled: false,
    jiraImportIntervalMinutes: 15,
    jiraImportAutoStart: false,
  };

  await page.route('**/api/projects/config', (route) => fulfillJson(route, { cloneRoot: '/tmp' }));
  await page.route('**/api/projects', (route) => fulfillJson(route, [project]));
  await page.route('**/api/groups?**', (route) => fulfillJson(route, []));
  await page.route('**/api/agents**', (route) => fulfillJson(route, []));
  await page.route('**/api/tasks/*/attachments**', (route) => fulfillJson(route, []));
  await page.route('**/api/tasks/*/status**', (route) => maybeContinue(route));
  await page.route('**/api/tasks/*/message**', (route) => maybeContinue(route));
  await page.route('**/api/tasks/*/run**', (route) => maybeContinue(route));
  await page.route('**/api/tasks/*/stop**', (route) => maybeContinue(route));
  await page.route('**/api/tasks/*', (route) => {
    if (route.request().method() === 'PATCH') {
      void fulfillJson(route, { ...baseTask, ...taskOverrides });
      return;
    }
    void maybeContinue(route);
  });
  await page.route(`**/api/tasks/${TASK_ID}/git-info`, (route) => fulfillJson(route, { hasRemote: false }));
  await page.route(`**/api/tasks/${TASK_ID}/events`, (route) => fulfillJson(route, events));
  await page.route('**/api/tasks?**', (route) => fulfillJson(route, [{ ...baseTask, ...taskOverrides }]));
  await page.route(`**/api/tasks/${TASK_ID}/clarification/resume`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }

    const json = route.request().postDataJSON() as ResumeCall;
    calls.push(json);
    await fulfillJson(route, {
      success: true,
      code: 'resumed',
      message: 'clarification accepted and session resumed',
    });
  });
}

test.describe('Task detail clarification card', () => {
  test('renders prompt + choices and submits selected choice exactly once with request/session payload', async ({ page }) => {
    const calls: ResumeCall[] = [];
    await mockClarificationBoard(
      page,
      {},
      [
        {
          id: 'evt-clarification-1',
          taskId: TASK_ID,
          type: 'command',
          content: PROMPT,
          timestamp: Date.now() - 5_000,
          metadata: {
            clarification_request: {
              requestId: REQUEST_ID,
              prompt: PROMPT,
              choices: CHOICES,
              timestamp: Date.now() - 5_000,
            },
          },
        },
      ],
      calls,
    );

    await page.goto('/');
    await waitForBoard(page);

    await page.locator('div.group').filter({ hasText: 'Clarification UI task' }).click();
    const card = page.getByTestId('clarification-card');
    await expect(card.getByText('Clarification Needed')).toBeVisible();
    await expect(card.getByText(PROMPT)).toBeVisible();
    await expect(page.getByRole('button', { name: CHOICES[0] })).toBeVisible();
    await expect(page.getByRole('button', { name: CHOICES[1] })).toBeVisible();

    const firstChoice = page.getByRole('button', { name: CHOICES[0] });
    await firstChoice.dblclick();

    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({
      requestId: REQUEST_ID,
      sessionId: SESSION_ID,
      answer: CHOICES[0],
    });
    await expect(page.getByText(`Submitted: ${CHOICES[0]}`)).toBeVisible();
  });

  test('submits free-text clarification reply with same request/session payload shape', async ({ page }) => {
    const calls: ResumeCall[] = [];
    await mockClarificationBoard(
      page,
      {
        clarificationRequest: {
          requestId: REQUEST_ID,
          sessionId: SESSION_ID,
          prompt: PROMPT,
          timestamp: Date.now() - 5_000,
        },
      },
      [],
      calls,
    );

    await page.goto('/');
    await waitForBoard(page);
    await page.locator('div.group').filter({ hasText: 'Clarification UI task' }).click();

    const freeTextAnswer = 'Use the JS zip library so we can keep behavior cross-platform.';
    const input = page.getByPlaceholder('Type your response...');
    await input.fill(freeTextAnswer);
    await page.getByRole('button', { name: 'Submit clarification reply' }).click();

    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({
      requestId: REQUEST_ID,
      sessionId: SESSION_ID,
      answer: freeTextAnswer,
    });
    await expect(page.getByText(`Submitted: ${freeTextAnswer}`)).toBeVisible();
  });

  test('disables clarification submission once task leaves awaiting_clarification while keeping historical clarification visible', async ({ page }) => {
    const calls: ResumeCall[] = [];
    const taskOverrides: Record<string, unknown> = {
      agentStatus: 'executing',
      clarificationAnswer: null,
    };

    await mockClarificationBoard(
      page,
      taskOverrides,
      [
        {
          id: 'evt-clarification-history-1',
          taskId: TASK_ID,
          type: 'command',
          content: PROMPT,
          timestamp: Date.now() - 5_000,
          metadata: {
            clarification_request: {
              requestId: REQUEST_ID,
              prompt: PROMPT,
              choices: CHOICES,
              timestamp: Date.now() - 5_000,
            },
          },
        },
      ],
      calls,
    );

    await page.goto('/');
    await waitForBoard(page);
    await page.locator('div.group').filter({ hasText: 'Clarification UI task' }).click();

    const card = page.getByTestId('clarification-card');
    await expect(card.getByText('Clarification Needed')).toBeVisible();
    await expect(card.getByText(PROMPT)).toBeVisible();
    await expect(page.getByRole('button', { name: CHOICES[0], exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: CHOICES[1], exact: true })).toBeDisabled();
    await page.getByRole('button', { name: CHOICES[0], exact: true }).click({ force: true });
    expect(calls).toHaveLength(0);

    taskOverrides.agentStatus = 'complete';
    taskOverrides.clarificationAnswer = {
      requestId: REQUEST_ID,
      sessionId: SESSION_ID,
      answer: CHOICES[1],
      timestamp: Date.now() - 1_000,
    };

    await page.reload();
    await waitForBoard(page);
    await page.locator('div.group').filter({ hasText: 'Clarification UI task' }).click();
    await expect(page.getByTestId('clarification-card').getByText(PROMPT)).toBeVisible();
    await expect(page.getByText(`Submitted: ${CHOICES[1]}`)).toBeVisible();
  });
});
