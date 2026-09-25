import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const TEST_SERVER_PORT = process.env.E2E_SERVER_PORT ?? '3002';
export const API = `http://localhost:${TEST_SERVER_PORT}`;
const DEFAULT_TEST_REPO_NAME = 'test-repo';

type PrepareRepoOptions = {
  branch?: string;
  clean?: boolean;
  files?: Record<string, string>;
};

const preparedRepos = new Set<string>();

function sanitizeRepoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || DEFAULT_TEST_REPO_NAME;
}

/** Run git without shell interpolation so paths with spaces work on every platform. */
export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

export function getTestRepoPath(name = DEFAULT_TEST_REPO_NAME): string {
  const root = process.env.E2E_TEST_REPO_ROOT
    ? path.resolve(process.env.E2E_TEST_REPO_ROOT)
    : path.resolve(process.cwd(), 'test-results', 'repos');
  return path.join(root, sanitizeRepoName(name));
}

function isGitRepo(repoPath: string): boolean {
  if (!existsSync(repoPath)) return false;
  try {
    git(['rev-parse', '--is-inside-work-tree'], repoPath);
    return true;
  } catch {
    return false;
  }
}

/** Prepare a deterministic, valid git repo for tests that need a local path. */
export function prepareTestRepo(name = DEFAULT_TEST_REPO_NAME, options: PrepareRepoOptions = {}): string {
  const repoPath = getTestRepoPath(name);
  const branch = options.branch ?? 'main';
  const files = options.files ?? {
    'README.md': '# E2E Test Repo\n\nRepository prepared by Playwright tests.\n',
  };
  const needsInit = options.clean || !preparedRepos.has(repoPath) || !isGitRepo(repoPath);

  if (!needsInit) return repoPath;

  rmSync(repoPath, { recursive: true, force: true });
  mkdirSync(repoPath, { recursive: true });

  try {
    git(['init', '-b', branch], repoPath);
  } catch {
    git(['init'], repoPath);
    git(['checkout', '-b', branch], repoPath);
  }

  git(['config', 'user.email', 'test@test.com'], repoPath);
  git(['config', 'user.name', 'E2E Test'], repoPath);

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(repoPath, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }

  git(['add', '.'], repoPath);
  git(['commit', '--allow-empty', '-m', 'init'], repoPath);
  preparedRepos.add(repoPath);
  return repoPath;
}

export function cleanupTestPath(targetPath: string): void {
  rmSync(targetPath, { recursive: true, force: true });
}

export async function fillLocalPath(page: Page, repoPath = prepareTestRepo()): Promise<string> {
  const input = page.getByLabel(/Local Path/i);
  if (await input.isVisible().catch(() => false)) {
    await input.fill(repoPath);
  }
  return repoPath;
}

/** Wait for the board to render all four column headings. */
export async function waitForBoard(page: Page) {
  const newTaskBtn = page.getByRole('button', { name: 'New Task' });
  const backlogHeading = page.getByRole('heading', { name: 'Backlog', exact: true });
  await expect(newTaskBtn.or(backlogHeading).first()).toBeVisible({ timeout: 10_000 });
}

/** Create a task via the REST API. Returns the parsed JSON response. */
export async function createTaskViaAPI(request: any, overrides: Record<string, any> = {}): Promise<any> {
  const res = await request.post(`${API}/api/tasks`, {
    data: {
      title: overrides.title || 'Test Task',
      description: 'Test',
      columnId: overrides.columnId || 'backlog',
      ...overrides,
    },
  });
  return res.json();
}

/**
 * Start a task on the board host's in-process agent manager via the
 * orchestration API. Board tasks otherwise run on remote workers; the E2E
 * harness backs the in-process `opencode` agent with a deterministic
 * clarification provider (it asks "Which branch should I target?").
 */
export async function startInProcessRun(
  request: any,
  title: string,
): Promise<{ taskId: string; projectId: string; cleanup: () => Promise<void> }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const repoPath = prepareTestRepo(`in-process-${stamp}`, { clean: true });
  const projectRes = await request.post(`${API}/api/projects`, {
    data: { name: `In-process ${stamp}`, repoPath, defaultAgentType: 'opencode' },
  });
  expect(projectRes.status()).toBe(201);
  const projectId = String((await projectRes.json()).id);

  const runRes = await request.post(`${API}/api/orchestrations`, {
    headers: { 'Idempotency-Key': `in-process-${stamp}` },
    data: { project: projectId, agent: 'opencode', title, description: title, autoStart: true },
  });
  expect(runRes.status()).toBe(201);
  const taskId = String((await runRes.json()).task.id);

  return {
    taskId,
    projectId,
    cleanup: async () => {
      await request.post(`${API}/api/tasks/${taskId}/stop`).catch(() => {});
      await request.delete(`${API}/api/tasks/${taskId}`).catch(() => {});
      await request.delete(`${API}/api/projects/${projectId}`).catch(() => {});
    },
  };
}

/** Register a worker via the worker API and return its id and token. */
export async function registerWorker(request: any, name: string): Promise<{ id: string; token: string }> {
  const res = await request.post(`${API}/api/workers/register`, {
    data: { name, agentTypes: ['opencode'], maxConcurrentTasks: 1, hostname: `${name}-host` },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return { id: body.worker.id, token: body.token };
}

/** Delete a task by ID via the REST API (cleanup). */
export async function deleteTaskViaAPI(request: any, id: string): Promise<void> {
  await request.delete(`${API}/api/tasks/${id}`);
}
