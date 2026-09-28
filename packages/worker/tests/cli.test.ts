import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_DESCRIPTION_LENGTH } from '@ai-agent-board/shared/constants.js';
import { completeTaskFailure, fetchAssignments, registerTaskSession, requestWithLoggedFailure } from '../src/api.js';
import { parseWorkspaceSettings } from '../src/local-runner.js';
import { truncateQuestion } from '../src/cli.js';

test('requestWithLoggedFailure returns undefined and logs the API failure', async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message: unknown): void => {
    errors.push(String(message));
  };

  try {
    const result = await requestWithLoggedFailure('assignment poll', async () => {
      throw new Error('fetch failed');
    });

    assert.equal(result, undefined);
    assert.deepEqual(errors, ['[worker] assignment poll failed: fetch failed']);
  } finally {
    console.error = originalError;
  }
});

test('fetchAssignments absorbs request failures so the worker loop can retry', async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message: unknown): void => {
    errors.push(String(message));
  };

  try {
    const tasks = await fetchAssignments(
      { serverUrl: 'http://worker.example', workerId: 'worker-1', workerToken: 'token' },
      async () => {
        throw new Error('fetch failed');
      },
    );

    assert.equal(tasks, undefined);
    assert.deepEqual(errors, ['[worker] assignment poll failed: fetch failed']);
  } finally {
    console.error = originalError;
  }
});

test('completeTaskFailure never throws when the completion API is unavailable', async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message: unknown): void => {
    errors.push(String(message));
  };

  try {
    await completeTaskFailure(
      { serverUrl: 'http://worker.example', workerId: 'worker-1', workerToken: 'token' },
      'task-1',
      'claim-token',
      'network down',
      async () => {
        throw new Error('fetch failed');
      },
    );

    assert.deepEqual(errors, ['[worker] task completion failed: fetch failed']);
  } finally {
    console.error = originalError;
  }
});

test('parseWorkspaceSettings rejects unknown runner kinds', () => {
  assert.throws(
    () => parseWorkspaceSettings({ workspacePath: '/tmp/workspace', runner: { kind: 'shell' } }),
    /runner.kind must be either "agent-sdk" or "opencode-server"/,
  );
});

test('registerTaskSession sends only sessionId and bridge URL without local workspace leakage', async () => {
  let capturedBody = '';
  await registerTaskSession(
    { serverUrl: 'http://worker.example', workerId: 'worker-1', workerToken: 'token' },
    'task-1',
    'claim-token',
    'ses_worker_1',
    'http://127.0.0.1:4455/session/task-1',
    async (_config, endpoint, init) => {
      assert.equal(endpoint, '/me/tasks/task-1/session');
      capturedBody = String(init?.body ?? '');
      return { success: true };
    },
  );

  const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
  assert.deepEqual(parsed, {
    sessionId: 'ses_worker_1',
    baseUrl: 'http://127.0.0.1:4455/session/task-1',
  });
  assert.equal(capturedBody.includes('/tmp/workspace'), false);
  assert.equal(capturedBody.includes('/L1VzZXJz'), false);
});

// SHOULD-FIX 2 regression: truncate worker-side, before POSTing, so a
// runaway extraction (extractInputRequest) can never produce a `question`
// that exceeds the server's MAX_DESCRIPTION_LENGTH and gets rejected with a
// 400 — which used to turn a paused task into a `failed` one, losing both the
// question and the work summary.
test('truncateQuestion caps a question at MAX_DESCRIPTION_LENGTH', () => {
  const short = 'Which environment should this target?';
  assert.equal(truncateQuestion(short), short);

  const long = 'x'.repeat(MAX_DESCRIPTION_LENGTH + 500);
  const truncated = truncateQuestion(long);
  assert.equal(truncated.length, MAX_DESCRIPTION_LENGTH);
  assert.equal(truncated, long.slice(0, MAX_DESCRIPTION_LENGTH));
});
