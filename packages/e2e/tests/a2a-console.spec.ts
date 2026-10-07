import { test, expect } from '@playwright/test';

test.describe('A2A-first console', () => {
  test('shows the agent directory and an empty workflow history when enabled', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'A2A Console' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Agent Directory' })).toBeVisible();
    await expect(page.getByText('No A2A agents registered yet.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Workflow History' })).toBeVisible();
    await expect(page.getByText('No workflow runs have been recorded for this project.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Assign Worker|Agent Roster|Worker/ })).toHaveCount(0);
  });
});
