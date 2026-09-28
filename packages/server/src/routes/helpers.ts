import { Request, Response, NextFunction } from 'express';
import { v4 as uuid } from 'uuid';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Project, Task, TaskGroup, WorkerTaskAssignment } from '../types.js';
import { isValidPriority, isValidColumnId, isValidAgentType, isValidAgentTimeoutMinutes, VALID_AGENT_TYPES, MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_LABELS, MAX_LABEL_LENGTH, MAX_AGENT_PREFERENCE_LENGTH, MIN_AGENT_TIMEOUT_MINUTES, MAX_AGENT_TIMEOUT_MINUTES } from '@ai-agent-board/shared/constants.js';
import { errorMessage } from '../utils.js';
import { getCloneRoot } from '../config.js';
import type { TaskRepository } from '../repositories/types.js';
import { broadcast } from '../websocket.js';
import type { AgentManager } from '../services/agent-manager.js';
import type { Worker } from '../types.js';

// ─── Async handler wrapper ──────────────────────────────────────────

type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/** Wrap async Express handlers so rejected promises forward to the error middleware. */
export function asyncHandler(fn: AsyncRouteHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ─── Param helpers ──────────────────────────────────────────────────

export function paramId(req: Request): string {
  const id = req.params.id;
  return typeof id === 'string' ? id : id[0];
}

// ─── Git ref validation ─────────────────────────────────────────────

const GIT_REF_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/;
export function isValidGitRef(ref: string): boolean {
  return GIT_REF_RE.test(ref) && !ref.includes('..') && !ref.endsWith('.lock') && ref.length <= 200;
}

// ─── Repo-path validation ───────────────────────────────────────────

// Default whitelist when ALLOWED_REPO_ROOTS is unset: home dir + tmp + this workspace.
// Prevents agents from accessing /etc, /proc, etc. while still allowing local dev repos.
const CONFIGURED_REPO_ROOTS: string[] = process.env.ALLOWED_REPO_ROOTS
  ? process.env.ALLOWED_REPO_ROOTS.split(',').map((p) => expandTilde(p.trim())).filter(Boolean)
  : getDefaultAllowedRepoRoots();

/**
 * Resolve the effective set of allowed repo roots. The configured clone root is
 * always included so that repos cloned from a URL pass validation even when
 * ALLOWED_REPO_ROOTS is explicitly set (e.g. in CI/e2e environments).
 */
function getAllowedRepoRoots(): string[] {
  try {
    return dedupePaths([...CONFIGURED_REPO_ROOTS, getCloneRoot()]);
  } catch {
    return CONFIGURED_REPO_ROOTS;
  }
}

function getDefaultAllowedRepoRoots(): string[] {
  const roots = [
    os.homedir(),
    os.tmpdir(),
    process.cwd(),
  ];

  if (process.env.PROJECTS_DIR) {
    roots.push(expandTilde(process.env.PROJECTS_DIR));
  }

  const workspaceRoot = findWorkspaceRoot(process.cwd());
  if (workspaceRoot) {
    roots.push(workspaceRoot);
  }

  return dedupePaths(roots);
}

function findWorkspaceRoot(start: string): string | null {
  let current = path.resolve(start);

  for (let depth = 0; depth < 5; depth += 1) {
    const parent = path.dirname(current);
    if (
      path.basename(current) === 'server'
      && path.basename(parent) === 'packages'
      && fs.existsSync(path.join(path.dirname(parent), 'package.json'))
    ) {
      return path.dirname(parent);
    }
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    if (parent === current) return null;
    current = parent;
  }

  return null;
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of paths) {
    const resolved = realOrResolve(candidate);
    const key = normalizeForBoundaryCheck(resolved);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(resolved);
    }
  }

  return result;
}

/** Canonicalize a path, falling back to path.resolve if it doesn't exist yet. */
function realOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function normalizeForBoundaryCheck(p: string): string {
  const normalized = path.normalize(p);
  const root = path.parse(normalized).root;
  const withoutTrailingSeparators = normalized.length > root.length
    ? normalized.replace(/[\\/]+$/, '')
    : normalized;
  return process.platform === 'win32' ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators;
}

function isPathUnderRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeForBoundaryCheck(candidate);
  const normalizedRoot = normalizeForBoundaryCheck(root);
  const rootPath = normalizeForBoundaryCheck(path.parse(root).root);

  if (normalizedRoot === rootPath) {
    return normalizedCandidate.startsWith(normalizedRoot);
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + path.sep);
}

export function isAllowedRepoPath(repoPath: string): string | null {
  const resolved = realOrResolve(repoPath);
  const roots = getAllowedRepoRoots();

  const underAllowedRoot = roots.some((root) => {
    const realRoot = realOrResolve(root);
    return isPathUnderRoot(resolved, realRoot);
  });
  if (!underAllowedRoot) {
    return `repoPath must be under one of: ${roots.join(', ')}`;
  }

  // Create directory if it doesn't exist; verify it's a directory if it does
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return `repoPath is not a directory: ${resolved}`;
    }
  } catch {
    try {
      fs.mkdirSync(resolved, { recursive: true });
      console.log(`[repo-path] created directory ${resolved}`);
    } catch (err: unknown) {
      return `Failed to create directory: ${errorMessage(err)}`;
    }
  }

  // Must have read/write access
  try {
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    return `No read/write access to: ${resolved}`;
  }

  // Initialize git repo if not already one
  const gitDir = path.join(resolved, '.git');
  if (!fs.existsSync(gitDir)) {
    try {
      execFileSync('git', ['init'], { cwd: resolved, stdio: 'pipe' });
      console.log(`[repo-path] initialized git repo at ${resolved}`);
    } catch (err: unknown) {
      return `Failed to initialize git repository: ${errorMessage(err)}`;
    }
  }

  return null;
}

/**
 * Pure boundary check: returns null if `targetPath` resolves under an allowed
 * repo root, otherwise an error message. Unlike isAllowedRepoPath it has NO side
 * effects (no mkdir, no git init), making it safe to call on a prospective git
 * clone target before the directory exists.
 */
export function isUnderAllowedRoots(targetPath: string): string | null {
  const resolved = realOrResolve(targetPath);
  const roots = getAllowedRepoRoots();
  const ok = roots.some((root) => isPathUnderRoot(resolved, realOrResolve(root)));
  return ok ? null : `path must be under one of: ${roots.join(', ')}`;
}

export interface RepoPathValidation {
  repoPath: string;
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  error?: string;
  warning?: string;
}

export function validateRepoPath(repoPath: string): RepoPathValidation {
  const expanded = expandTilde(repoPath);
  if (!path.isAbsolute(expanded)) {
    return {
      repoPath: expanded,
      valid: false,
      exists: false,
      isDirectory: false,
      isGitRepo: false,
      error: 'repoPath must be an absolute path',
    };
  }

  const resolved = realOrResolve(expanded);
  const roots = getAllowedRepoRoots();
  const underAllowedRoot = roots.some((root) => isPathUnderRoot(resolved, realOrResolve(root)));
  if (!underAllowedRoot) {
    return {
      repoPath: resolved,
      valid: false,
      exists: false,
      isDirectory: false,
      isGitRepo: false,
      error: `repoPath must be under one of: ${roots.join(', ')}`,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return {
      repoPath: resolved,
      valid: false,
      exists: false,
      isDirectory: false,
      isGitRepo: false,
      error: `repoPath does not exist: ${resolved}`,
    };
  }

  if (!stat.isDirectory()) {
    return {
      repoPath: resolved,
      valid: false,
      exists: true,
      isDirectory: false,
      isGitRepo: false,
      error: `repoPath is not a directory: ${resolved}`,
    };
  }

  try {
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
  } catch (err: unknown) {
    return {
      repoPath: resolved,
      valid: false,
      exists: true,
      isDirectory: true,
      isGitRepo: false,
      error: `No read/write access to: ${resolved}: ${errorMessage(err)}`,
    };
  }

  const isGitRepo = isGitWorkTree(resolved);
  return {
    repoPath: resolved,
    valid: true,
    exists: true,
    isDirectory: true,
    isGitRepo,
    ...(isGitRepo ? {} : { warning: 'Path is not a git repository; it will be initialized when saved.' }),
  };
}

export function isGitWorkTree(repoPath: string): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath, stdio: 'pipe' })
      .toString()
      .trim() === 'true';
  } catch {
    return false;
  }
}

// ─── Git URL parsing + cloning ──────────────────────────────────────

export interface ParsedRepoUrl {
  url: string;
  /** Filesystem-safe directory name derived from the repo URL. */
  name: string;
}

const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

function deriveRepoName(url: string): string | null {
  let s = url.trim().split(/[?#]/)[0];
  s = s.replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  const segment = s.split(/[\\/:]/).filter(Boolean).pop() ?? '';
  const safe = segment.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!safe || safe === '.' || safe === '..') return null;
  return safe;
}

/**
 * Validate and parse a git repo URL. Accepts http(s)/ssh/git/file URLs, scp-like
 * refs (git@host:owner/repo.git) and absolute local paths (used for offline/dev
 * mirrors). Returns the parsed URL + a safe directory name, or an error string.
 */
export function parseGitRepoUrl(input: string): ParsedRepoUrl | string {
  const url = input.trim();
  if (!url) return 'repoUrl must be a non-empty string';
  if (url.length > 2048) return 'repoUrl is too long';
  if (CONTROL_CHARS_RE.test(url)) return 'repoUrl contains invalid control characters';
  if (url.startsWith('-')) return 'repoUrl must not start with "-"';

  const isUrlScheme = /^(https?|ssh|git|file):\/\//i.test(url);
  const isScpLike = !url.includes('://') && /^[^@/\\]+@[^:/\\]+:.+/.test(url);
  const isLocalAbs = path.isAbsolute(url);
  if (!isUrlScheme && !isScpLike && !isLocalAbs) {
    return 'repoUrl must be an http(s)/ssh/git/file URL, an scp-like ref, or an absolute local path';
  }

  const name = deriveRepoName(url);
  if (!name) return 'could not derive a repository name from repoUrl';
  return { url, name };
}

/** Normalize a git URL for equality comparison (case/slash/.git/trailing-slash insensitive). */
export function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

/** Return the `origin` remote URL of a repo, or null if none/not a repo. */
export function getGitRemoteOrigin(repoPath: string): string | null {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, stdio: 'pipe' })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Clone `repoUrl` into `targetPath`. Uses execFileSync (no shell) and disables
 * interactive credential prompts so private repos without ambient credentials
 * fail fast instead of hanging.
 */
export function cloneRepo(repoUrl: string, targetPath: string, timeoutMs = 120_000): void {
  execFileSync('git', ['clone', '--', repoUrl, targetPath], {
    stdio: 'pipe',
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

export function expandTilde(p: string): string {
  if (!p.startsWith('~')) return p;
  const rest = p.slice(p.startsWith('~/') || p.startsWith('~\\') ? 2 : 1);
  return path.join(os.homedir(), rest);
}

export function normalizeRepoPathForCompare(repoPath: string): string {
  return normalizeForBoundaryCheck(realOrResolve(expandTilde(repoPath)));
}

export type PortableTask = Omit<Task, 'repoPath' | 'worktreePath'>;
export type PortableTaskGroup = Omit<TaskGroup, 'repoPath'>;

export function toPortableTask(task: Task): PortableTask {
  const { repoPath: _repoPath, worktreePath: _worktreePath, ...portable } = task;
  return { ...portable, labels: task.labels ?? [] };
}

export function toPortableTaskGroup(group: TaskGroup): PortableTaskGroup {
  const { repoPath: _repoPath, ...portable } = group;
  return portable;
}

export function rejectTaskPathFields(body: Record<string, unknown>): string | null {
  if ('repoPath' in body) return 'repoPath is not supported for tasks';
  if ('worktreePath' in body) return 'worktreePath is not supported for tasks';
  for (const field of ['workspacePath', 'projectPath', 'command', 'executable', 'skill']) {
    if (field in body) return `${field} is not supported for tasks`;
  }
  return null;
}

export function rejectGroupPathFields(body: Record<string, unknown>): string | null {
  if ('repoPath' in body) return 'repoPath is not supported for groups';
  if ('worktreePath' in body) return 'worktreePath is not supported for groups';
  return null;
}

// ─── Broadcast helpers ──────────────────────────────────────────────

export function broadcastTaskUpdate(task: Task): void {
  broadcast({ type: 'task_updated', payload: toPortableTask(task) });
}

export function toWorkerTaskAssignment(task: Task): WorkerTaskAssignment {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    ...(task.agentType === undefined ? {} : { agentType: task.agentType }),
    ...(task.branchName === undefined ? {} : { branchName: task.branchName }),
    ...(task.baseBranch === undefined ? {} : { baseBranch: task.baseBranch }),
    ...(task.useWorktree === undefined ? {} : { useWorktree: task.useWorktree }),
    ...(task.timeoutMinutes === undefined ? {} : { timeoutMinutes: task.timeoutMinutes }),
    labels: task.labels ?? [],
    ...(task.agentPreference === undefined ? {} : { agentPreference: task.agentPreference }),
    // A run started from Review validates the existing work instead of re-implementing it.
    ...(task.columnId === 'review' ? { mode: 'review' as const } : {}),
  };
}

export function broadcastWorkerUpdate(worker: Worker & { readonly tokenHash?: string }): void {
  // Strip tokenHash at the broadcast boundary — every connected WebSocket
  // client receives this payload, so callers should never need to remember
  // to sanitize it themselves (unlike the HTTP responses in routes/workers.ts,
  // which build a public view per-request).
  const { tokenHash: _tokenHash, ...publicWorker } = worker;
  broadcast({ type: 'worker_updated', payload: publicWorker as Worker });
}

export function broadcastWorkerRemove(id: string): void {
  broadcast({ type: 'worker_removed', payload: { id } });
}

export function broadcastGroupUpdate(group: TaskGroup): void {
  broadcast({ type: 'group_updated', payload: toPortableTaskGroup(group) });
}

export function broadcastProjectUpdate(project: Project): void {
  broadcast({ type: 'project_updated', payload: project });
}

export function broadcastProjectDelete(id: string): void {
  broadcast({ type: 'project_deleted', payload: { id } });
}

export async function failTaskWithEvent(
  repo: TaskRepository,
  task: Task,
  content: string,
): Promise<Task | undefined> {
  const event = {
    id: uuid(),
    taskId: task.id,
    type: 'error' as const,
    content,
    timestamp: Date.now(),
    metadata: {
      agentType: task.agentType,
      duration: 0,
      error: content,
    },
  };

  await repo.insertEvent(event);
  broadcast({ type: 'agent_event', payload: event });
  broadcast({
    type: 'agent_complete',
    payload: {
      taskId: task.id,
      status: 'failed',
      agentType: task.agentType,
      duration: 0,
      eventCount: 1,
    },
  });

  const failed = await repo.update(task.id, {
    agentStatus: 'failed',
    completedAt: event.timestamp,
  });
  if (failed) broadcastTaskUpdate(failed);
  return failed;
}

// ─── Rate limiter ───────────────────────────────────────────────────

const RATE_LIMIT_MS = 5_000;
const RATE_LIMIT_CLEANUP_THRESHOLD = 100;
const agentActionTimestamps = new Map<string, number>();
const JIRA_RETRY_DELAY_MS = 30_000;
const retriedJiraTaskIds = new Set<string>();

export function shouldRetryJiraTask(task: Task, failure: string, alreadyRetried: boolean): boolean {
  if (task.externalSource !== 'jira' || alreadyRetried) return false;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|not reachable|is not running|network error|connection (?:closed|reset|refused|timed out)/i.test(failure);
}

export function isRateLimited(taskId: string): boolean {
  const now = Date.now();
  const last = agentActionTimestamps.get(taskId);
  if (last && now - last < RATE_LIMIT_MS) return true;
  agentActionTimestamps.set(taskId, now);
  if (agentActionTimestamps.size > RATE_LIMIT_CLEANUP_THRESHOLD) {
    for (const [id, ts] of agentActionTimestamps) {
      if (now - ts > RATE_LIMIT_MS) agentActionTimestamps.delete(id);
    }
  }
  return false;
}

// ─── Task field validation ──────────────────────────────────────────

export function normalizeTaskLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const label = item.trim().toLowerCase();
    if (label && label.length <= MAX_LABEL_LENGTH && !labels.includes(label)) labels.push(label);
    if (labels.length === MAX_LABELS) break;
  }
  return labels;
}

export function validateTaskFields(body: Record<string, any>): string | null {
  const { title, description, priority, columnId, agentType, branchName, baseBranch, useWorktree, autoRun, timeoutMinutes, labels, agentPreference } = body;

  if (!title || typeof title !== 'string' || !title.trim()) {
    return 'title is required and must be a non-empty string';
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return `title must be at most ${MAX_TITLE_LENGTH} characters`;
  }
  if (description !== undefined && typeof description !== 'string') {
    return 'description must be a string';
  }
  if (typeof description === 'string' && description.length > MAX_DESCRIPTION_LENGTH) {
    return `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`;
  }
  if (priority !== undefined && !isValidPriority(priority)) {
    return 'invalid priority: must be one of low, medium, high, critical';
  }
  if (columnId !== undefined && !isValidColumnId(columnId)) {
    return 'invalid columnId: must be one of backlog, in-progress, pending, review, done';
  }
  if (agentType !== undefined && !isValidAgentType(agentType)) {
    return `invalid agentType: must be one of ${VALID_AGENT_TYPES.join(', ')}`;
  }
  if (branchName !== undefined && typeof branchName !== 'string') {
    return 'branchName must be a string';
  }
  if (typeof branchName === 'string' && branchName !== '' && !isValidGitRef(branchName)) {
    return 'branchName contains invalid characters';
  }
  if (baseBranch !== undefined && typeof baseBranch !== 'string') {
    return 'baseBranch must be a string';
  }
  if (typeof baseBranch === 'string' && !isValidGitRef(baseBranch)) {
    return 'baseBranch contains invalid characters';
  }
  if (useWorktree !== undefined && typeof useWorktree !== 'boolean') {
    return 'useWorktree must be a boolean';
  }
  if (autoRun !== undefined && typeof autoRun !== 'boolean') {
    return 'autoRun must be a boolean';
  }
  if (timeoutMinutes !== undefined && !isValidAgentTimeoutMinutes(timeoutMinutes)) {
    return `timeoutMinutes must be an integer between ${MIN_AGENT_TIMEOUT_MINUTES} and ${MAX_AGENT_TIMEOUT_MINUTES}`;
  }
  if (labels !== undefined && (!Array.isArray(labels) || labels.length > MAX_LABELS || labels.some((label: unknown) => typeof label !== 'string' || label.trim().length === 0 || label.trim().length > MAX_LABEL_LENGTH))) {
    return `labels must contain at most ${MAX_LABELS} non-empty strings of at most ${MAX_LABEL_LENGTH} characters`;
  }
  if (agentPreference !== undefined && (typeof agentPreference !== 'string' || agentPreference.trim().length > MAX_AGENT_PREFERENCE_LENGTH)) {
    return `agentPreference must be a string of at most ${MAX_AGENT_PREFERENCE_LENGTH} characters`;
  }
  return null;
}

// ─── Task builder ───────────────────────────────────────────────────

export function buildTask(body: Record<string, any>): Task {
  const { title, description, priority, columnId, agentType, branchName, baseBranch, useWorktree, projectId, timeoutMinutes, agentPreference } = body;
  return {
    id: uuid(),
    projectId: typeof projectId === 'string' && projectId ? projectId : 'default',
    title,
    description: description || '',
    priority: priority || 'medium',
    columnId: columnId || 'backlog',
    agentStatus: 'idle',
    agentType: agentType || 'opencode',
    createdAt: Date.now(),
    branchName: branchName || undefined,
    baseBranch: baseBranch || undefined,
    useWorktree: useWorktree ?? undefined, externalSource: body.externalSource, externalKey: body.externalKey, provenance: body.provenance, runRequestedAt: body.runRequestedAt,
    timeoutMinutes,
    labels: normalizeTaskLabels(body.labels),
    ...(typeof agentPreference === 'string' && agentPreference.trim() ? { agentPreference: agentPreference.trim() } : {}),
  };
}

// ─── Agent lifecycle helpers ────────────────────────────────────────

export function makeStatusCallback(repo: TaskRepository, taskId: string): (status: Task['agentStatus']) => void {
  return async (status) => {
    const current = await repo.getById(taskId);
    if (!current) return;

    const statusUpdates: Partial<Task> = { agentStatus: status };
    if (status === 'awaiting_clarification') {
      statusUpdates.columnId = 'pending';
    }
    if (status === 'executing' && current.columnId === 'pending') {
      statusUpdates.columnId = 'in-progress';
    }
    if (status === 'complete') {
      statusUpdates.completedAt = Date.now();
      statusUpdates.columnId = 'review';
    }
    if (status === 'failed') {
      statusUpdates.completedAt = Date.now();
      if (current.columnId === 'pending') {
        statusUpdates.columnId = 'in-progress';
      }
    }
    const t = await repo.update(taskId, statusUpdates);
    if (t) broadcastTaskUpdate(t);
  };
}

export function makeWorktreeCallback(repo: TaskRepository, taskId: string): (worktreePath: string) => void {
  return async (worktreePath) => {
    const t = await repo.update(taskId, { worktreePath });
    if (t) broadcastTaskUpdate(t);
  };
}

export async function startAgentForTask(
  task: Task,
  repo: TaskRepository,
  agentManager: AgentManager,
): Promise<void> {
  const claimed = await repo.claimRun(task.id, Date.now());
  if (!claimed) return;
  task = claimed;
  const updates: Partial<Task> = {
    agentStatus: 'planning',
    startedAt: Date.now(),
    completedAt: undefined,
  };
  if (task.columnId === 'backlog') {
    updates.columnId = 'in-progress';
  }
  const updated = await repo.update(task.id, updates);
  if (updated) {
    broadcastTaskUpdate(updated);
    agentManager.startAgent(
      updated,
      makeRetryAwareStatusHandler(repo, agentManager, updated),
      makeWorktreeCallback(repo, task.id),
    );
  }
}

interface RetryAwareStatusHandlerDeps {
  scheduleRetry?: (fn: () => void, delayMs: number) => void;
}

/**
 * Build the `onStatusChange` callback passed to `agentManager.startAgent`.
 * Every entry point that starts an agent (direct run, group child, durable
 * retry/dispatch) must route through this single handler — a duplicated
 * inline callback silently drops the transient-Jira-failure auto-retry,
 * which is exactly the bug this function was extracted to close.
 */
export function makeRetryAwareStatusHandler(
  repo: TaskRepository,
  agentManager: AgentManager,
  task: Task,
  deps: RetryAwareStatusHandlerDeps = {},
): (status: Task['agentStatus'], failure?: string) => Promise<void> {
  const scheduleRetry = deps.scheduleRetry ?? ((fn, delayMs) => { setTimeout(fn, delayMs); });
  const onStatusChange = makeStatusCallback(repo, task.id);
  return async (status, failure) => {
    if (status === 'complete' || status === 'failed') await repo.clearRun(task.id);
    await onStatusChange(status);
    if (status === 'failed' && failure && shouldRetryJiraTask(task, failure, retriedJiraTaskIds.has(task.id))) {
      retriedJiraTaskIds.add(task.id);
      scheduleRetry(() => {
        void retryTransientJiraTask(task.id, repo, agentManager);
      }, JIRA_RETRY_DELAY_MS);
    }
  };
}

async function retryTransientJiraTask(taskId: string, repo: TaskRepository, agentManager: AgentManager): Promise<void> {
  try {
    const task = await repo.getById(taskId);
    if (!task || task.agentStatus !== 'failed') return;
    const reset = await repo.update(task.id, {
      agentStatus: 'idle',
      startedAt: undefined,
      completedAt: undefined,
    });
    if (!reset) return;
    broadcastTaskUpdate(reset);
    await repo.requestRun(reset.id, Date.now());
    await startAgentForTask(reset, repo, agentManager);
  } catch (error) {
    console.warn(`[jira-retry] failed to retry task ${taskId}: ${errorMessage(error)}`);
  }
}
