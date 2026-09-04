import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task } from '../src/types.js';
import { shouldRetryJiraTask } from '../src/routes/helpers.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    title: 'Jira task',
    description: '',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'failed',
    createdAt: 1,
    externalSource: 'jira',
    ...overrides,
  };
}

test('shouldRetryJiraTask accepts one transient Jira agent failure only', () => {
  assert.equal(shouldRetryJiraTask(makeTask(), 'OpenCode SDK error: connect ECONNREFUSED 127.0.0.1:4096', false), true);
  assert.equal(shouldRetryJiraTask(makeTask(), 'Worktree setup failed: Worktree tasks require branchName', false), false);
  assert.equal(shouldRetryJiraTask(makeTask({ externalSource: 'api' }), 'socket hang up', false), false);
  assert.equal(shouldRetryJiraTask(makeTask(), 'socket hang up', true), false);
});

test('shouldRetryJiraTask retries the OpenCode-unreachable "fetch failed" message', () => {
  const failure = 'OpenCode SDK error: fetch failed\n\n💡 The OpenCode server is not running or not reachable. Start it with: opencode serve --port 4096, or check your hostname/port configuration.';
  assert.equal(shouldRetryJiraTask(makeTask(), failure, false), true);
});
