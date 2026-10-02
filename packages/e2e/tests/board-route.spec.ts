import { test, expect, type Page } from '@playwright/test';
import { createTaskViaAPI, waitForBoard } from './helpers';

// The Worker Operations Console stays the root view; the drag-and-drop
// Kanban board is reachable at /board and /projects/:id/board (issue #58).

const COLUMN_HEADINGS = ['Backlog', 'In Progress', 'Pending', 'Review', 'Done'];

async function expectKanbanColumns(page: Page) {
  for (const name of COLUMN_HEADINGS) {
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 10_000 });
  }
}

test.describe('Kanban board route', () => {
  test('/board renders the Kanban columns', async ({ page }) => {
    await page.goto('/board');
    await expectKanbanColumns(page);
    await expect(page.getByRole('button', { name: 'Console view' })).toBeVisible();
  });

  test('/projects/:id/board renders the Kanban columns for that project', async ({ page }) => {
    await page.goto('/projects/default/board');
    await expectKanbanColumns(page);
  });

  test('toggles console -> board -> console', async ({ page }) => {
    await page.goto('/');
    await waitForBoard(page);
    await expect(page.getByRole('button', { name: /All Issues/ })).toBeVisible();

    await page.getByRole('button', { name: 'Board view' }).click();
    await expect(page).toHaveURL(/\/board$/);
    await expectKanbanColumns(page);

    await page.getByRole('button', { name: 'Console view' }).click();
    await expect(page).not.toHaveURL(/\/board/);
    await expect(page.getByRole('button', { name: /All Issues/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Board view' })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/board$/);
    await expectKanbanColumns(page);
  });

  test('task created via API appears on the board', async ({ page, request }) => {
    const title = `Board route task ${Date.now()}`;
    await createTaskViaAPI(request, { title, columnId: 'backlog' });

    await page.goto('/board');
    await expectKanbanColumns(page);
    await expect(page.locator('[data-column="backlog"]').getByText(title)).toBeVisible({ timeout: 10_000 });
  });
});
