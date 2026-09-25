import { expect, test } from '@playwright/test';
import { API, deleteTaskViaAPI, prepareTestRepo, waitForBoard } from './helpers';

async function waitForTaskState(
  request: { get(url: string): Promise<{ status(): number; json(): Promise<any> }> },
  taskId: string,
  predicate: (task: any) => boolean,
  timeoutMs: number,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const response = await request.get(`${API}/api/tasks/${taskId}/status`);
    expect(response.status()).toBe(200);
    const status = await response.json();
    last = status;
    if (predicate(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const events = await (await request.get(`${API}/api/tasks/${taskId}/events`)).json();
  const errors = (events as Array<{ type: string; content: string }>).filter((event) => event.type === 'error').map((event) => event.content);
  throw new Error(`Timed out waiting for task state: ${taskId}; last status ${JSON.stringify(last)}; errors ${JSON.stringify(errors)}`);
}

async function fetchTask(
  request: { get(url: string): Promise<{ status(): number; json(): Promise<any> }> },
  projectId: string,
  taskId: string,
): Promise<any> {
  const response = await request.get(`${API}/api/tasks?projectId=${projectId}`);
  expect(response.status()).toBe(200);
  const tasks = await response.json();
  const task = tasks.find((candidate: any) => candidate.id === taskId);
  expect(task).toBeTruthy();
  return task;
}

test.describe('Clarification reconnect flow', () => {
  test('reload/reconnect while awaiting clarification shows persisted prompt and resumes same session end-to-end', async ({ page, request }) => {
    const stamp = Date.now();
    const title = `Clarification reconnect ${stamp}`;
    const repoPath = prepareTestRepo(`clarification-reconnect-${stamp}`, { clean: true });
    let projectId: string | null = null;
    let taskId: string | null = null;

    try {
      const projectResponse = await request.post(`${API}/api/projects`, {
        data: { name: `Clarification Reconnect ${stamp}`, repoPath, defaultAgentType: 'opencode' },
      });
      expect(projectResponse.status()).toBe(201);
      projectId = String((await projectResponse.json()).id);

      // Orchestrated tasks run on the board host's in-process agent manager,
      // which the E2E harness backs with the deterministic clarification
      // provider (worker-assigned tasks are executed by remote workers).
      const orchestration = await request.post(`${API}/api/orchestrations`, {
        headers: { 'Idempotency-Key': `clarification-reconnect-${stamp}` },
        data: {
          project: projectId,
          agent: 'opencode',
          title,
          description: 'e2e clarification reconnect flow',
          autoStart: true,
        },
      });
      expect(orchestration.status()).toBe(201);
      taskId = String((await orchestration.json()).task.id);

      await waitForTaskState(
        request,
        taskId,
        (status) => status.agentStatus === 'awaiting_clarification',
        15_000,
      );

      const awaitingTask = await fetchTask(request, projectId, taskId);
      expect(awaitingTask.columnId).toBe('pending');
      const requestPayload = awaitingTask.clarificationRequest;
      expect(requestPayload).toBeTruthy();
      expect(typeof requestPayload.requestId).toBe('string');
      expect(typeof requestPayload.sessionId).toBe('string');
      expect(requestPayload.prompt).toBe('Which branch should I target?');
      expect(requestPayload.choices).toEqual(['main', 'develop']);

      await page.goto(`/projects/${projectId}/tasks/${taskId}`);
      await waitForBoard(page);
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(page.getByTestId('clarification-card')).toBeVisible();
      await expect(page.getByTestId('clarification-prompt')).toHaveText('Which branch should I target?');
      await expect(page.getByRole('button', { name: 'main', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'develop', exact: true })).toBeVisible();

      await page.reload();
      await waitForBoard(page);
      await expect(page.getByTestId('clarification-card')).toBeVisible();
      await expect(page.getByTestId('clarification-prompt')).toHaveText('Which branch should I target?');

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

      const completedTask = await fetchTask(request, projectId, taskId);
      expect(completedTask.agentStatus).toBe('complete');
      expect(completedTask.columnId).toBe('review');
      expect(completedTask.clarificationAnswer).toBeTruthy();
      expect(completedTask.clarificationAnswer.requestId).toBe(requestPayload.requestId);
      expect(completedTask.clarificationAnswer.sessionId).toBe(requestPayload.sessionId);
      expect(completedTask.clarificationAnswer.answer).toBe('main');
    } finally {
      if (taskId) {
        await request.post(`${API}/api/tasks/${taskId}/stop`).catch(() => undefined);
        await deleteTaskViaAPI(request, taskId);
      }
      if (projectId) {
        await request.delete(`${API}/api/projects/${projectId}`).catch(() => undefined);
      }
    }
  });
});
