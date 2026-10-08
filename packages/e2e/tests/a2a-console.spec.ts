import { test, expect } from '@playwright/test';

const a2aFirstEnabled = process.env.E2E_A2A_FIRST_UI === 'true';

test.describe('A2A-first console when disabled', () => {
  test.skip(a2aFirstEnabled, 'The A2A config exercises the enabled mode.');

  test('keeps the Worker Console and makes no A2A API requests', async ({ page }) => {
    const a2aRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/a2a')) a2aRequests.push(request.url());
    });

    await page.goto('/');

    await expect(page.getByText('Saved Views')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agent Roster' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A2A Console' })).toHaveCount(0);
    expect(a2aRequests).toEqual([]);
  });

});

test.describe('A2A-first console when enabled', () => {
  test.skip(!a2aFirstEnabled, 'The default config exercises the disabled mode.');

  test('shows the agent directory and an empty workflow history', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'A2A Console' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Agent Directory' })).toBeVisible();
    await expect(page.getByText('No A2A agents registered yet.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Workflow History' })).toBeVisible();
    await expect(page.getByText('No workflow runs have been recorded for this project.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Assign Worker|Agent Roster|Worker/ })).toHaveCount(0);
  });
});
