import { test, expect, type Page } from '@playwright/test';
import { API, waitForBoard } from './helpers';

// The root view is the Worker Operations Console (saved views + task queue +
// task detail panel). These specs cover its task workflows; the legacy
// drag-and-drop Kanban board is no longer mounted.

async function openCreateDialog(page: Page) {
  await page.getByRole('button', { name: 'New Task' }).click();
  await expect(page.getByRole('heading', { name: 'Create Task' })).toBeVisible();
}

function taskRow(page: Page, title: string) {
  return page.locator('div.group').filter({ hasText: title });
}

async function createTask(page: Page, title: string, description = 'Test description'): Promise<string> {
  await openCreateDialog(page);
  await page.getByPlaceholder('What needs to be done?').fill(title);
  await page.getByPlaceholder('Describe the task for the selected agent...').fill(description);
  await page.getByRole('button', { name: 'Create Task' }).click();
  await expect(page.getByRole('heading', { name: 'Create Task' })).not.toBeVisible({ timeout: 3_000 });
  await expect(taskRow(page, title)).toBeVisible({ timeout: 5_000 });
  const id = await page.evaluate(async (t) => {
    const res = await fetch('/api/tasks');
    const tasks = await res.json();
    return tasks.find((tk: any) => tk.title === t)?.id ?? null;
  }, title);
  expect(id).toBeTruthy();
  return id as string;
}

async function createTaskViaApi(request: any, data: Record<string, unknown>): Promise<any> {
  const res = await request.post(`${API}/api/tasks`, { data: { description: 'test', ...data } });
  expect(res.status()).toBe(201);
  return res.json();
}

test.describe('Worker console shell', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForBoard(page);
  });

  test('renders the saved views', async ({ page }) => {
    for (const view of ['All Issues', 'Active / Executing', 'Backlog', 'Done / Completed']) {
      await expect(page.getByRole('button', { name: new RegExp(view) })).toBeVisible();
    }
  });

  test('shows the current project in the project switcher', async ({ page }) => {
    const switcher = page.getByRole('button', { name: /Default/ }).first();
    await expect(switcher).toBeVisible();
    await switcher.click();
    await expect(page.getByText('Switch Project')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Manage All Projects...' })).toBeVisible();
  });

  test('has theme toggle button', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Toggle theme' })).toBeVisible();
  });
});

test.describe('Task CRUD', () => {
  let createdTaskIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    createdTaskIds = [];
    await page.goto('/');
    await waitForBoard(page);
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  test('create a new task', async ({ page }) => {
    const ts = Date.now();
    const taskTitle = `E2E Task ${ts}`;
    const taskDesc = `Automated test description ${ts}`;
    const id = await createTask(page, taskTitle, taskDesc);
    createdTaskIds.push(id);

    await taskRow(page, taskTitle).click();
    await expect(page.getByRole('heading', { name: taskTitle })).toBeVisible();
    await expect(page.getByText(taskDesc)).toBeVisible();
  });

  test('create task dialog opens and closes', async ({ page }) => {
    await openCreateDialog(page);
    await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByPlaceholder('What needs to be done?')).not.toBeVisible({ timeout: 2_000 });
  });

  test('create task requires title', async ({ page }) => {
    await openCreateDialog(page);
    const createButton = page.getByRole('button', { name: 'Create Task' });
    await expect(createButton).toBeDisabled();
    await page.getByPlaceholder('What needs to be done?').fill('Valid Task');
    await expect(createButton).toBeEnabled();
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('click task to open the task detail panel', async ({ page }) => {
    const taskTitle = `Panel Task ${Date.now()}`;
    const taskId = await createTask(page, taskTitle);
    createdTaskIds.push(taskId);

    await taskRow(page, taskTitle).click();
    await expect(page.getByRole('heading', { name: taskTitle })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Run Agent' })).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText('No events recorded yet.')).toBeVisible();
  });

  test('review tasks are grouped under Completed & Review', async ({ page, request }) => {
    const taskTitle = `Review Group ${Date.now()}`;
    const task = await createTaskViaApi(request, { title: taskTitle, columnId: 'in-progress' });
    createdTaskIds.push(task.id);
    const moved = await request.patch(`${API}/api/tasks/${task.id}`, { data: { columnId: 'review' } });
    expect(moved.status()).toBe(200);

    await page.reload();
    await waitForBoard(page);
    await page.getByPlaceholder('Filter tasks (press / to focus)...').fill(taskTitle);
    await expect(page.getByText('Completed & Review')).toBeVisible();
    await expect(taskRow(page, taskTitle)).toBeVisible();
  });

  test('run button on a queued task requests an agent run', async ({ page, request }) => {
    const taskTitle = `Run Start Task ${Date.now()}`;
    const task = await createTaskViaApi(request, { title: taskTitle });
    createdTaskIds.push(task.id);

    let runRequests = 0;
    await page.route(`**/api/tasks/${task.id}/run`, async (route) => {
      runRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...task, columnId: 'in-progress', agentStatus: 'planning', agentType: 'opencode' }),
      });
    });

    await page.reload();
    await waitForBoard(page);
    const row = taskRow(page, taskTitle);
    await row.hover();
    await row.getByRole('button', { name: 'Run Agent' }).click();

    await expect.poll(() => runRequests).toBe(1);
  });
});

test.describe('Theme Toggle', () => {
  test('toggles between dark and light mode', async ({ page }) => {
    await page.goto('/');
    await waitForBoard(page);

    const themeButton = page.getByRole('button', { name: 'Toggle theme' });
    const html = page.locator('html');
    const initialClass = await html.getAttribute('class');

    await themeButton.click();
    await expect.poll(() => html.getAttribute('class')).not.toBe(initialClass);

    await themeButton.click();
    await expect.poll(() => html.getAttribute('class')).toBe(initialClass);
  });
});

test.describe('Task Priority', () => {
  let createdTaskIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    createdTaskIds = [];
    await page.goto('/');
    await waitForBoard(page);
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  test('create task with high priority shows HIGH badge', async ({ page }) => {
    const taskTitle = `Priority Task ${Date.now()}`;

    await openCreateDialog(page);
    await page.getByPlaceholder('What needs to be done?').fill(taskTitle);
    const dialog = page.getByRole('dialog');
    await dialog.locator('button', { hasText: 'Medium' }).first().click();
    await dialog.getByRole('button', { name: '🟠 High' }).click();
    await page.getByRole('button', { name: 'Create Task' }).click();
    await expect(page.getByRole('heading', { name: 'Create Task' })).not.toBeVisible({ timeout: 3_000 });

    const id = await page.evaluate(async (t) => {
      const res = await fetch('/api/tasks');
      const tasks = await res.json();
      return tasks.find((tk: any) => tk.title === t)?.id ?? null;
    }, taskTitle);
    createdTaskIds.push(id as string);

    await expect(taskRow(page, taskTitle).getByText('HIGH', { exact: true })).toBeVisible();
  });

  test('editing priority in the detail panel persists and updates the badge', async ({ page, request }) => {
    const taskTitle = `Edit Priority ${Date.now()}`;
    const task = await createTaskViaApi(request, { title: taskTitle });
    createdTaskIds.push(task.id);

    await page.reload();
    await waitForBoard(page);
    const row = taskRow(page, taskTitle);
    await expect(row.getByText('MED', { exact: true })).toBeVisible();

    await row.click();
    const priority = page.locator('select').filter({ has: page.locator('option[value="critical"]') }).last();
    await priority.selectOption('critical');

    await expect(row.getByText('CRITICAL', { exact: true })).toBeVisible({ timeout: 3_000 });
    const tasks = await (await request.get(`${API}/api/tasks`)).json();
    expect(tasks.find((t: any) => t.id === task.id)?.priority).toBe('critical');
  });
});

test.describe('Task Sorting and Filtering', () => {
  const prefix = `SortFilter ${Date.now()}`;
  let createdTaskIds: string[] = [];

  test.beforeEach(async ({ page, request }) => {
    createdTaskIds = [];
    for (const t of [
      { title: `${prefix} Beta Low`, priority: 'low' },
      { title: `${prefix} Alpha Critical`, priority: 'critical' },
      { title: `${prefix} Gamma High`, priority: 'high' },
    ]) {
      createdTaskIds.push((await createTaskViaApi(request, t)).id);
    }
    await page.goto('/');
    await waitForBoard(page);
    await page.getByPlaceholder('Filter tasks (press / to focus)...').fill(prefix);
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  async function visibleTitles(page: Page): Promise<string[]> {
    const titles = await page.locator('div.group span.truncate').allTextContents();
    return titles.filter((t) => t.startsWith(prefix));
  }

  test('sort by priority puts critical first and low last', async ({ page }) => {
    await page.locator('select').filter({ has: page.locator('option[value="title"]') }).selectOption('priority');
    await expect.poll(() => visibleTitles(page)).toEqual([
      `${prefix} Alpha Critical`,
      `${prefix} Gamma High`,
      `${prefix} Beta Low`,
    ]);
  });

  test('sort by title orders alphabetically', async ({ page }) => {
    await page.locator('select').filter({ has: page.locator('option[value="title"]') }).selectOption('title');
    await expect.poll(() => visibleTitles(page)).toEqual([
      `${prefix} Alpha Critical`,
      `${prefix} Beta Low`,
      `${prefix} Gamma High`,
    ]);
  });

  test('priority filter shows only matching tasks and search narrows by title', async ({ page }) => {
    await page.locator('select').filter({ has: page.locator('option[value="all"]', { hasText: 'All Priorities' }) }).selectOption('high');
    await expect.poll(() => visibleTitles(page)).toEqual([`${prefix} Gamma High`]);

    await page.locator('select').filter({ has: page.locator('option[value="all"]', { hasText: 'All Priorities' }) }).selectOption('all');
    await page.getByPlaceholder('Filter tasks (press / to focus)...').fill(`${prefix} Beta`);
    await expect.poll(() => visibleTitles(page)).toEqual([`${prefix} Beta Low`]);
  });
});

test.describe('Retry Failed Tasks', () => {
  let createdTaskIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  test('failed tasks offer Run Agent to retry', async ({ page, request }) => {
    const title = `Retry Test Task ${Date.now()}`;
    const task = await createTaskViaApi(request, { title, columnId: 'in-progress' });
    createdTaskIds.push(task.id);
    await request.patch(`${API}/api/tasks/${task.id}`, { data: { agentStatus: 'failed' } });

    await page.goto('/');
    await waitForBoard(page);
    await taskRow(page, title).click();
    await expect(page.getByText('failed', { exact: true })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Run Agent' })).toBeVisible();
  });

  test('failed task can be re-claimed via the run endpoint', async ({ request }) => {
    const task = await createTaskViaApi(request, { title: 'Reclaim Test Task', columnId: 'in-progress' });
    createdTaskIds.push(task.id);

    await request.patch(`${API}/api/tasks/${task.id}`, {
      data: { agentStatus: 'failed', assignedWorkerId: 'worker-1' },
    });

    const run = await request.post(`${API}/api/tasks/${task.id}/run`);
    expect(run.status()).toBe(200);
    expect((await run.json()).agentStatus).toBe('planning');
  });
});

test.describe('Worker-owned task git actions', () => {
  let createdTaskIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  test('hides board-host merge/PR/cleanup buttons for worker-assigned tasks while retaining branch display', async ({ page, request }) => {
    const hostTitle = `Host Task ${Date.now()}`;
    const workerTitle = `Worker Task ${Date.now()}`;
    const branchFields = { columnId: 'in-progress', branchName: 'task/feature-branch', baseBranch: 'main', useWorktree: true };
    const hostTask = await createTaskViaApi(request, { title: hostTitle, ...branchFields });
    const workerTask = await createTaskViaApi(request, { title: workerTitle, ...branchFields });
    createdTaskIds.push(hostTask.id, workerTask.id);
    await request.patch(`${API}/api/tasks/${workerTask.id}`, { data: { assignedWorkerId: 'worker-1' } });

    await page.goto('/');
    await waitForBoard(page);

    await taskRow(page, hostTitle).click();
    await expect(page.getByRole('button', { name: 'Create PR' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Merge Local' })).toBeVisible();

    await taskRow(page, workerTitle).click();
    await expect(page.getByRole('heading', { name: workerTitle })).toBeVisible();
    await expect(page.getByText('task/feature-branch')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create PR' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Merge Local' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clean Worktree' })).toHaveCount(0);
  });
});
