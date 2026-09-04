import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, waitForBoard } from './helpers';

type Project = {
  id: string;
  name: string;
};

async function createProject(request: APIRequestContext, name: string): Promise<Project> {
  const response = await request.post(`${API}/api/projects`, {
    data: { name },
  });
  expect(response.status()).toBe(201);
  return response.json() as Promise<Project>;
}

test.describe('Jira Import Flow', () => {
  const createdProjectIds: string[] = [];
  const createdTaskIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForBoard(page);
  });

  test.afterEach(async ({ request }) => {
    for (const taskId of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${taskId}`).catch(() => {});
    }
    for (const projectId of createdProjectIds) {
      await request.delete(`${API}/api/projects/${projectId}`).catch(() => {});
    }
    createdTaskIds.length = 0;
    createdProjectIds.length = 0;
  });

  test('uses the current project as the default Jira import target', async ({ page }) => {
    const taskTitle = `PROJ-88 Fix SSO token refresh bug ${Date.now()}`;
    const mockTask = {
      id: `jira-imported-task-default-${Date.now()}`,
      title: taskTitle,
      description: 'Imported from Jira issue PROJ-88',
      priority: 'high',
      columnId: 'backlog',
      agentStatus: 'idle',
      createdAt: Date.now(),
      projectId: 'default',
    };

    await page.route('**/api/jira/import-assigned', async (route) => {
      const request = route.request();
      expect(request.method()).toBe('POST');
      const postData = request.postDataJSON();
      expect(postData).toEqual({ projectId: 'default' });
      createdTaskIds.push(mockTask.id);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total: 3,
          created: 1,
          skipped: 2,
          tasks: [mockTask],
        }),
      });
    });

    const importButton = page.getByRole('button', { name: 'Import Jira' }).first();
    await expect(importButton).toBeVisible();
    await importButton.click();

    const dialog = page.getByRole('dialog', { name: 'Import Assigned Jira Issues' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/read-only/i)).toBeVisible();
    await expect(dialog.getByLabel('Jira project')).toHaveValue('default');

    const submitButton = dialog.getByTestId('jira-import-submit');
    await expect(submitButton).toBeVisible();
    await submitButton.click();

    await expect(dialog.getByTestId('jira-import-total')).toHaveText('3');
    await expect(dialog.getByTestId('jira-import-created')).toHaveText('1');
    await expect(dialog.getByTestId('jira-import-skipped')).toHaveText('2');

    await expect(dialog.getByText('PROJ-88 Fix SSO token refresh bug')).toBeVisible();

    const closeButton = dialog.getByRole('button', { name: 'Close', exact: true });
    await closeButton.click();
    await expect(dialog).not.toBeVisible();

    await expect(page.getByRole('heading', { name: taskTitle })).toBeVisible();
  });

  test('sends the selected alternate Jira project and keeps it off the current board', async ({ page, request }) => {
    const alternateProject = await createProject(request, `Alternate Jira Project ${Date.now()}`);
    createdProjectIds.push(alternateProject.id);

    const taskTitle = `PROJ-42 Alternate project import ${Date.now()}`;
    const mockTask = {
      id: `jira-imported-task-alternate-${Date.now()}`,
      title: taskTitle,
      description: 'Imported from Jira issue PROJ-42',
      priority: 'medium',
      columnId: 'backlog',
      agentStatus: 'idle',
      createdAt: Date.now(),
      projectId: alternateProject.id,
    };

    await page.route('**/api/jira/import-assigned', async (route) => {
      const request = route.request();
      expect(request.method()).toBe('POST');
      const postData = request.postDataJSON();
      expect(postData).toEqual({ projectId: alternateProject.id });
      createdTaskIds.push(mockTask.id);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total: 1,
          created: 1,
          skipped: 0,
          tasks: [mockTask],
        }),
      });
    });

    const importButton = page.getByRole('button', { name: 'Import Jira' }).first();
    await importButton.click();

    const dialog = page.getByRole('dialog', { name: 'Import Assigned Jira Issues' });
    await expect(dialog).toBeVisible();

    const jiraProjectSelect = dialog.getByLabel('Jira project');
    await expect(jiraProjectSelect).toHaveValue('default');
    await jiraProjectSelect.selectOption(alternateProject.id);
    await expect(jiraProjectSelect).toHaveValue(alternateProject.id);

    await dialog.getByTestId('jira-import-submit').click();

    await expect(dialog.getByText(taskTitle)).toBeVisible();

    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).not.toBeVisible();

    await expect(page.getByText(taskTitle, { exact: true })).toHaveCount(0);
  });

  test('handles Jira import error and loading disabled state', async ({ page }) => {
    let routeCalled = false;
    await page.route('**/api/jira/import-assigned', async (route) => {
      routeCalled = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Jira API token expired or invalid credentials.' }),
      });
    });

    const importButton = page.getByRole('button', { name: 'Import Jira' }).first();
    await importButton.click();

    const dialog = page.getByRole('dialog', { name: 'Import Assigned Jira Issues' });
    await expect(dialog).toBeVisible();

    const submitButton = dialog.getByTestId('jira-import-submit');
    await submitButton.click();

    await expect(dialog.getByText('Importing…')).toBeVisible();
    await expect(submitButton).toBeDisabled();

    await expect(dialog.getByText('Jira API token expired or invalid credentials.')).toBeVisible();
    expect(routeCalled).toBe(true);
  });
});
