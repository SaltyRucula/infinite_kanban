import { test, expect, type Page } from '@playwright/test';
import { API, fillLocalPath, waitForBoard } from './helpers';

const AGENT_LABELS: Record<string, string> = {
  copilot: 'Copilot',
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  grok: 'Grok',
};

const AGENT_LABEL_ORDER = Object.values(AGENT_LABELS);

async function getPreferredAgent(request: any): Promise<{ name: string; label: string; hasAvailableAgent: boolean }> {
  const res = await request.get(`${API}/api/agents`);
  const agents = await res.json();
  const preferred = agents.find((agent: any) => agent.available)?.name ?? 'copilot';
  return {
    name: preferred,
    label: AGENT_LABELS[preferred] ?? preferred,
    hasAvailableAgent: agents.some((agent: any) => agent.available),
  };
}

async function openCreateDialog(page: Page) {
  const newTaskBtn = page.getByRole('button', { name: 'New Task' });
  if (await newTaskBtn.isVisible().catch(() => false)) {
    await newTaskBtn.click();
  } else {
    const backlogHeading = page.getByRole('heading', { name: 'Backlog', exact: true });
    const headerRow = backlogHeading.locator('..').locator('..');
    const addButton = headerRow.locator('button').first();
    await addButton.click();
  }
  await expect(page.getByRole('heading', { name: 'Create Task' })).toBeVisible();
}

async function createTask(page: Page, title: string, description = 'Test description') {
  await openCreateDialog(page);
  await page.getByPlaceholder('What needs to be done?').fill(title);
  await page.getByPlaceholder('Describe the task for the selected agent...').fill(description);
  await page.getByRole('button', { name: 'Create Task' }).click();
  await expect(page.getByRole('heading', { name: 'Create Task' })).not.toBeVisible({ timeout: 3_000 });
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 5_000 });
}

/** Create a task and move it to in-progress via API, then reload. Returns the task id. */
async function createTaskInProgress(page: Page, title: string, opts?: { agentType?: string }) {
  await createTask(page, title);

  const taskId = await page.evaluate(async (t) => {
    const res = await fetch('/api/tasks');
    const tasks = await res.json();
    return tasks.find((tk: any) => tk.title === t)?.id;
  }, title);

  // Move to in-progress (and optionally set agentType)
  const patchBody: Record<string, string> = { columnId: 'in-progress' };
  if (opts?.agentType) patchBody.agentType = opts.agentType;

  await page.evaluate(async ({ id, body }) => {
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }, { id: taskId, body: patchBody });

  await page.reload();
  await waitForBoard(page);
  return taskId as string;
}

/** Open the Create/Edit Task dialog's agent dropdown and return it. */
async function openAgentDropdown(page: Page) {
  const dialog = page.locator('[role="dialog"]');
  // Click the Agent dropdown button
  const agentLabel = dialog.getByText('Agent', { exact: true });
  const agentButton = agentLabel.locator('..').locator('button').first();
  await agentButton.click();
  return dialog;
}

// ---------------------------------------------------------------------------
// Tests – TaskDialog agent engine & labels
// ---------------------------------------------------------------------------

test.describe('OpenCode Engine and Labels in TaskDialog', () => {
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

  test('shows static OpenCode engine label and allows editing labels', async ({ page }) => {
    await openCreateDialog(page);
    const dialog = page.locator('[role="dialog"]');

    await expect(dialog.getByText('OpenCode / Sisyphus Worker')).toBeVisible();

    const title = `LabeledTask ${Date.now()}`;
    await page.getByPlaceholder('What needs to be done?').fill(title);
    await page.getByPlaceholder('e.g. frontend, bug, feature (comma-separated)').fill('frontend, e2e-test');
    await page.getByRole('button', { name: 'Create Task' }).click();

    await expect(page.getByRole('heading', { name: 'Create Task' })).not.toBeVisible({ timeout: 5_000 });
    const card = page.locator('.group').filter({ hasText: title });
    await expect(card).toBeVisible();
    await expect(page.getByText('frontend').first()).toBeVisible();
    await expect(page.getByText('e2e-test').first()).toBeVisible();
  });
});

test.describe('Worker Selection in TaskDialog', () => {
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

  test('shows empty state when no online workers match or are registered', async ({ page }) => {
    await openCreateDialog(page);
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByText('Assign to Registered Worker')).toBeVisible();
    await expect(dialog.getByText(/No online registered workers currently support/)).toBeVisible();
  });

  test('lists matching online worker and assigns it on task creation with no path required', async ({ page, request }) => {
    const regRes = await request.post(`${API}/api/workers/register`, {
      data: {
        name: 'OpencodeWorker-1',
        agentTypes: ['opencode'],
        maxConcurrentTasks: 2,
        hostname: 'opencode-host-1',
      },
    });
    expect(regRes.ok()).toBeTruthy();
    const regData = await regRes.json();
    const workerId = regData.worker.id;

    await page.goto('/');
    await waitForBoard(page);

    await openCreateDialog(page);
    const dialog = page.locator('[role="dialog"]');

    await expect(page.getByText('Local Path')).toHaveCount(0);

    await expect(dialog.getByText('OpencodeWorker-1')).toBeVisible({ timeout: 5_000 });

    await dialog.getByText('OpencodeWorker-1').click();

    const title = `WorkerTask ${Date.now()}`;
    await page.getByPlaceholder('What needs to be done?').fill(title);
    await page.getByRole('button', { name: 'Create Task' }).click();

    await expect(page.getByRole('heading', { name: 'Create Task' })).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 5_000 });

    const tasksRes = await request.get(`${API}/api/tasks`);
    const tasks = await tasksRes.json();
    const createdTask = tasks.find((t: any) => t.title === title);

    expect(createdTask).toBeDefined();
    expect(createdTask.assignedWorkerId).toBe(workerId);
    expect(createdTask.repoPath).toBeUndefined();

    if (createdTask) {
      createdTaskIds.push(createdTask.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests – Agent type badge on task cards
// ---------------------------------------------------------------------------

test.describe('Agent Type Badge on Task Cards', () => {
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

  test('agent type badge appears on task card when agentType is set and column is not backlog', async ({ page }) => {
    const title = `BadgeTask ${Date.now()}`;
    const taskId = await createTaskInProgress(page, title, { agentType: 'opencode' });
    createdTaskIds.push(taskId);

    const card = page.locator('.group').filter({ hasText: title });
    await expect(card.getByText('OpenCode')).toBeVisible();
  });

  test('agent type badge does NOT appear on backlog cards', async ({ page }) => {
    const title = `NoBadge ${Date.now()}`;
    await createTask(page, title);

    const taskId = await page.evaluate(async (t) => {
      const res = await fetch('/api/tasks');
      const tasks = await res.json();
      return tasks.find((tk: any) => tk.title === t)?.id;
    }, title);

    await page.evaluate(async ({ id }) => {
      await fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType: 'opencode' }),
      });
    }, { id: taskId });
    if (taskId) createdTaskIds.push(taskId);

    await page.reload();
    await waitForBoard(page);

    const card = page.locator('.group').filter({ hasText: title });
    await expect(card).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tests – Agent Panel header shows agent type
// ---------------------------------------------------------------------------

test.describe('Agent Panel Header', () => {
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

  test('shows the agent type label when task has agentType', async ({ page }) => {
    const title = `PanelAgent ${Date.now()}`;
    const taskId = await createTaskInProgress(page, title, { agentType: 'opencode' });
    createdTaskIds.push(taskId);

    await page.getByText(title).first().click();
    await expect(page.locator('span').filter({ hasText: 'OpenCode' }).first()).toBeVisible({ timeout: 5_000 });
  });
});
