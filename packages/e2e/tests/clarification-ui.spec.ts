import { expect, test } from '@playwright/test';
import { API, waitForBoard } from './helpers';

test.describe('Task detail clarification card (deep link)', () => {
  test('renders prompt/choices from persisted state and calls /clarification/resume exactly once', async ({ page }) => {
    const now = Date.now();
    const taskId = `clarify-task-${now}`;
    const requestId = `clarify-request-${now}`;
    const sessionId = `clarify-session-${now}`;
    const prompt = 'Which target should I use for rollout?';
    const choices = ['staging', 'production'];

    const taskPayload = {
      id: taskId,
      title: `Clarification Task ${now}`,
      description: 'Task seeded by Playwright route for clarification UI coverage.',
      priority: 'medium',
      columnId: 'in-progress',
      agentStatus: 'awaiting_clarification',
      createdAt: now,
      projectId: 'default',
      agentType: 'opencode',
      clarificationRequest: {
        requestId,
        prompt,
        choices,
        timestamp: now,
        sessionId,
      },
      clarificationAnswer: null,
    };

    let resumeCallCount = 0;
    let resumePayload: unknown = null;
    let tasksListCallCount = 0;

    await page.route(`**/api/tasks/${taskId}/clarification/resume`, async (route) => {
      resumeCallCount += 1;
      resumePayload = route.request().postDataJSON();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, code: 'resumed', message: 'clarification accepted and session resumed' }),
      });
    });

    await page.route(`**/api/tasks/${taskId}/events`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: `ev-clarification-${now}`,
            taskId,
            type: 'command',
            content: prompt,
            timestamp: now,
            metadata: {
              clarification_request: {
                requestId,
                prompt,
                choices,
                timestamp: now,
              },
            },
          },
        ]),
      });
    });

    await page.route(`**/api/tasks/${taskId}/git-info`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hasRemote: false }),
      });
    });

    const fulfillTasksList = async (route: { fulfill: (response: { status: number; contentType: string; body: string }) => Promise<void> }) => {
      tasksListCallCount += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([taskPayload]),
      });
    };

    await page.route('**/api/tasks', fulfillTasksList);
    await page.route('**/api/tasks?*', fulfillTasksList);

    await page.addInitScript(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });

    await page.goto(`/projects/default/tasks/${taskId}`);
    await waitForBoard(page);
    await expect.poll(() => tasksListCallCount).toBeGreaterThan(0);

    await expect(page.getByRole('heading', { name: taskPayload.title, exact: true })).toBeVisible();

    const clarificationCard = page.getByTestId('clarification-card');
    await expect(clarificationCard.getByText('Clarification Needed')).toBeVisible();
    await expect(clarificationCard.getByTestId('clarification-prompt')).toHaveText(prompt);
    await expect(page.getByRole('button', { name: 'staging', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'production', exact: true })).toBeVisible();

    await page.reload();
    await waitForBoard(page);
    await expect(page.getByTestId('clarification-card').getByText('Clarification Needed')).toBeVisible();
    await expect(page.getByTestId('clarification-prompt')).toHaveText(prompt);


    const choiceButton = page.getByRole('button', { name: 'staging', exact: true });
    await choiceButton.click();
    await expect(choiceButton).toBeDisabled();

    await expect.poll(() => resumeCallCount).toBe(1);
    expect(resumePayload).toEqual({ requestId, sessionId, answer: 'staging' });
    await expect(page.getByText('Submitted: staging')).toBeVisible();
  });
});
