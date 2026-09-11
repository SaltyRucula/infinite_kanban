import { expect, test } from '@playwright/test';
import { API, createTaskViaAPI, deleteTaskViaAPI, prepareTestRepo, waitForBoard } from './helpers';

async function waitForTaskState(
  request: { get(url: string): Promise<{ status(): number; json(): Promise<any> }> },
  taskId: string,
  predicate: (task: any) => boolean,
  timeoutMs: number,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request.get(`${API}/api/tasks/${taskId}/status`);
    expect(response.status()).toBe(200);
    const status = await response.json();
    if (predicate(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for task state: ${taskId}`);
}

async function fetchTask(
  request: { get(url: string): Promise<{ status(): number; json(): Promise<any> }> },
  taskId: string,
): Promise<any> {
  const response = await request.get(`${API}/api/tasks`);
  expect(response.status()).toBe(200);
  const tasks = await response.json();
  const task = tasks.find((candidate: any) => candidate.id === taskId);
  expect(task).toBeTruthy();
  return task;
}

test.describe('Clarification reconnect flow', () => {
  test('reload/reconnect while awaiting clarification shows persisted prompt and resumes same session end-to-end', async ({ page, request }) => {
    const title = `Clarification reconnect ${Date.now()}`;

    const created = await createTaskViaAPI(request, {
      title,
      description: 'e2e clarification reconnect flow',
      columnId: 'in-progress',
      agentType: 'opencode',
      assignedWorkerId: 'worker-1',
      autoRun: true,
    });
    const taskId = String(created.id);

    try {
      await waitForTaskState(
        request,
        taskId,
        (status) => status.agentStatus === 'awaiting_clarification',
        15_000,
      );

      const awaitingTask = await fetchTask(request, taskId);
      const requestPayload = awaitingTask.clarificationRequest;
      expect(requestPayload).toBeTruthy();
      expect(typeof requestPayload.requestId).toBe('string');
      expect(typeof requestPayload.sessionId).toBe('string');
      expect(requestPayload.prompt).toBe('Which branch should I target?');
      expect(requestPayload.choices).toEqual(['main', 'develop']);

      await page.goto(`/projects/default/tasks/${taskId}`);
      await waitForBoard(page);
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(page.getByTestId('clarification-card')).toBeVisible();
      await expect(page.getByTestId('clarification-prompt')).toHaveText('Which branch should I target?');
      await expect(page.getByRole('button', { name: 'main', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'develop', exact: true })).toBeVisible();
      await expect(page.getByPlaceholder('Send a message to the agent...')).toBeDisabled();

      await page.reload();
      await waitForBoard(page);
      await expect(page.getByTestId('clarification-card')).toBeVisible();
      await expect(page.getByTestId('clarification-prompt')).toHaveText('Which branch should I target?');
      await expect(page.getByPlaceholder('Send a message to the agent...')).toBeDisabled();

      const staleResponse = await request.post(`${API}/api/tasks/${taskId}/clarification/resume`, {
        data: {
          requestId: requestPayload.requestId,
          sessionId: 'stale-session-id',
          answer: 'main',
        },
      });
      expect(staleResponse.status()).toBe(409);
      const staleBody = await staleResponse.json();
      expect(staleBody.code).toBe('stale_session');

      await expect(page.getByRole('button', { name: 'main', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'main', exact: true }).click();
      await expect(page.getByText('Submitted: main')).toBeVisible();

      await waitForTaskState(
        request,
        taskId,
        (status) => status.agentStatus === 'complete',
        15_000,
      );

      const completedTask = await fetchTask(request, taskId);
      expect(completedTask.agentStatus).toBe('complete');
      expect(completedTask.clarificationAnswer).toBeTruthy();
      expect(completedTask.clarificationAnswer.requestId).toBe(requestPayload.requestId);
      expect(completedTask.clarificationAnswer.sessionId).toBe(requestPayload.sessionId);
      expect(completedTask.clarificationAnswer.answer).toBe('main');
    } finally {
      await request.post(`${API}/api/tasks/${taskId}/stop`).catch(() => undefined);
      await deleteTaskViaAPI(request, taskId);
    }
  });
});
