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

type WorkRequestApprovalCall = {
  readonly method: string;
  readonly url: string;
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

  test('shows a worker follow-up proposal and approves it explicitly without starting it', async ({ page }) => {
    const calls: ResumeCall[] = [];
    const approvals: WorkRequestApprovalCall[] = [];
    let runRequests = 0;
    const eventId = 'evt-work-request-1';
    const proposalTitle = 'Review the database migration';
    const proposalDescription = 'Validate rollout safety before deployment.';

    await mockClarificationBoard(
      page,
      { agentStatus: 'executing' },
      [{
        id: eventId,
        taskId: TASK_ID,
        type: 'request_work',
        content: 'Requesting a database review',
        timestamp: Date.now() - 5_000,
        metadata: {
          workRequest: {
            title: proposalTitle,
            description: proposalDescription,
            agentType: 'codex',
          },
        },
      }],
      calls,
    );
    await page.route(`**/api/tasks/${TASK_ID}/work-requests/${eventId}/approve`, async (route) => {
      approvals.push({ method: route.request().method(), url: route.request().url() });
      await fulfillJson(route, {
        id: 'created-follow-up',
        title: proposalTitle,
        description: proposalDescription,
        columnId: 'backlog',
        agentStatus: 'idle',
      });
    });
    await page.route(`**/api/tasks/${TASK_ID}/run`, async (route) => {
      runRequests += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'follow-up must not auto-run' }) });
    });

    await page.goto('/');
    await waitForBoard(page);
    await page.locator('div.group').filter({ hasText: 'Clarification UI task' }).click();

    const card = page.getByTestId('work-request-card');
    await expect(card.getByText('Suggested follow-up work')).toBeVisible();
    await expect(card.getByText(proposalTitle)).toBeVisible();
    await expect(card.getByText(proposalDescription)).toBeVisible();
    await page.getByRole('button', { name: 'Add to backlog' }).click();

    await expect.poll(() => approvals).toHaveLength(1);
    expect(approvals[0]?.method).toBe('POST');
    expect(runRequests).toBe(0);
    await expect(card.getByText('Added to backlog')).toBeVisible();
  });

  test('dismisses a worker follow-up proposal without creating or starting work', async ({ page }) => {
    const calls: ResumeCall[] = [];
    const eventId = 'evt-work-request-dismiss-1';
    const proposalTitle = 'Document the migration rollback plan';

    await mockClarificationBoard(
      page,
      { agentStatus: 'executing' },
      [{
        id: eventId,
        taskId: TASK_ID,
        type: 'request_work',
        content: 'Requesting documentation follow-up',
        timestamp: Date.now() - 5_000,
        metadata: {
          workRequest: {
            title: proposalTitle,
            description: 'Record the rollback steps before release.',
            agentType: 'codex',
          },
        },
      }],
      calls,
    );
    let approvalRequests = 0;
    let dismissalRequests = 0;
    let runRequests = 0;
    await page.route(`**/api/tasks/${TASK_ID}/work-requests/${eventId}/approve`, async (route) => {
      approvalRequests += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'dismiss must not approve' }) });
    });
    await page.route(`**/api/tasks/${TASK_ID}/work-requests/${eventId}/dismiss`, async (route) => {
      dismissalRequests += 1;
      await route.fulfill({ status: 204 });
    });
    await page.route(`**/api/tasks/${TASK_ID}/run`, async (route) => {
      runRequests += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'dismiss must not run' }) });
    });

    await page.goto('/');
    await waitForBoard(page);
    await page.locator('div.group').filter({ hasText: 'Clarification UI task' }).click();

    const card = page.getByTestId('work-request-card');
    await expect(card.getByText(proposalTitle)).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss' }).click();

    await expect(card).toHaveCount(0);
    await expect.poll(() => dismissalRequests).toBe(1);
    expect(approvalRequests).toBe(0);
    expect(runRequests).toBe(0);
  });

  test('places an approved follow-up proposal into an existing unstarted group without starting it', async ({ page }) => {
    const calls: ResumeCall[] = [];
    const approvalBodies: unknown[] = [];
    let runRequests = 0;
    const eventId = 'evt-work-request-group-1';
    const proposalTitle = 'Add rollback smoke test';
    const groupBase = {
      projectId: 'default',
      priority: 'medium',
      maxConcurrency: 1,
      createdAt: Date.now() - 30_000,
      children: [],
    };

    await mockClarificationBoard(
      page,
      { agentStatus: 'executing' },
      [{
        id: eventId,
        taskId: TASK_ID,
        type: 'request_work',
        content: 'Requesting a rollback test',
        timestamp: Date.now() - 5_000,
        metadata: {
          workRequest: {
            title: proposalTitle,
            description: 'Cover the rollback path before release.',
            agentType: 'codex',
          },
        },
      }],
      calls,
    );
    await page.route('**/api/groups?**', (route) => fulfillJson(route, [
      { ...groupBase, id: 'group-backlog', title: 'Release hardening', columnId: 'backlog' },
      { ...groupBase, id: 'group-started', title: 'Already running group', columnId: 'in-progress' },
    ]));
    await page.route(`**/api/tasks/${TASK_ID}/work-requests/${eventId}/approve`, async (route) => {
      approvalBodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'created-grouped-follow-up', title: proposalTitle, columnId: 'backlog', agentStatus: 'idle', groupId: 'group-backlog' }),
      });
    });
    await page.route(`**/api/tasks/${TASK_ID}/run`, async (route) => {
      runRequests += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'follow-up must not auto-run' }) });
    });

    await page.goto('/');
    await waitForBoard(page);
    await page.locator('div.group').filter({ hasText: 'Clarification UI task' }).click();

    const card = page.getByTestId('work-request-card');
    await expect(card.getByText(proposalTitle)).toBeVisible();
    const selector = card.getByRole('combobox', { name: 'Place in group' });
    await expect(selector).toBeVisible();
    await expect(selector.locator('option')).toHaveText(['No group', 'Release hardening']);
    await selector.selectOption('group-backlog');
    await card.getByRole('button', { name: 'Add to backlog' }).click();

    await expect.poll(() => approvalBodies).toHaveLength(1);
    expect(approvalBodies[0]).toEqual({ groupId: 'group-backlog' });
    await expect(card.getByText('Added to group: Release hardening')).toBeVisible();
    expect(runRequests).toBe(0);
  });
});
