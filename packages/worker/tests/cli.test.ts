import assert from 'node:assert/strict';
import test from 'node:test';
import { completeTaskFailure, fetchAssignments, requestWithLoggedFailure } from '../src/api.js';
import { parseWorkspaceSettings } from '../src/local-runner.js';

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
    /runner.kind must be either "agent-sdk" or "opencode-run"/,
  );
});
