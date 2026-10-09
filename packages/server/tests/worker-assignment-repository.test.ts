import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toWorkerTaskAssignment } from '../src/routes/helpers.js';
import { WORKER_TASK_ASSIGNMENT_KEYS } from '@ai-agent-board/shared/types.js';
import type { Project, Task } from '../src/types.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Add rate limiting',
    description: 'The worker event endpoint is unbounded.',
    columnId: 'backlog',
    priority: 'high',
    agentStatus: 'idle',
    projectId: 'project-1',
    labels: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Task;
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'board',
    repoPath: '/srv/boards/infinite_kanban',
    repoUrl: 'git@github.com:SaltyRucula/infinite_kanban.git',
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Project;
}

test('the assignment names the repository in canonical form', () => {
  const assignment = toWorkerTaskAssignment(task(), project());
  assert.deepEqual(assignment.repository, { url: 'github.com/saltyrucula/infinite_kanban' });
});

test('the host path never travels with the repository identity', () => {
  // repoPath is the board host's own filesystem; an executor elsewhere cannot
  // use it and must never be handed it.
  const serialized = JSON.stringify(toWorkerTaskAssignment(task(), project()));
  assert.equal(serialized.includes('/srv/boards'), false);
  assert.equal(serialized.includes('repoPath'), false);
});

test('a project with no remote sends no repository at all', () => {
  // Keeps the executor's existing workspace-root behaviour instead of sending
  // something it cannot resolve.
  const assignment = toWorkerTaskAssignment(task(), project({ repoUrl: undefined }));
  assert.equal(assignment.repository, undefined);
  assert.equal(toWorkerTaskAssignment(task(), undefined).repository, undefined);
});

test('an unparseable remote is omitted rather than forwarded', () => {
  const assignment = toWorkerTaskAssignment(task(), project({ repoUrl: 'not a url' }));
  assert.equal(assignment.repository, undefined);
});

test('repository is covered by the handoff allowlist', () => {
  // The allowlist is the single gate on what may leave the board, so a new
  // field has to be declared there to travel at all.
  assert.equal((WORKER_TASK_ASSIGNMENT_KEYS as readonly string[]).includes('repository'), true);
  for (const key of Object.keys(toWorkerTaskAssignment(task(), project()))) {
    assert.equal(
      (WORKER_TASK_ASSIGNMENT_KEYS as readonly string[]).includes(key),
      true,
      `${key} is not in the assignment allowlist`,
    );
  }
});
