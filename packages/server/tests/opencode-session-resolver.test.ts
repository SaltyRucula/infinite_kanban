import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveTaskOpenCodeSession,
  type OpenCodeSessionClient,
  type RegisteredWorkerOpenCodeSession,
} from '../src/opencode/session-resolver.js';

function makeSession(overrides: Partial<RegisteredWorkerOpenCodeSession> = {}): RegisteredWorkerOpenCodeSession {
  return {
    sessionId: 'ses_1',
    baseUrl: 'http://127.0.0.1:4096',
    updatedAt: 1,
    ...overrides,
  };
}

test('resolveTaskOpenCodeSession prefers an active worker session registration', async () => {
  const result = resolveTaskOpenCodeSession(
    [
      makeSession({ sessionId: 'ses_old', updatedAt: 10 }),
      makeSession({ sessionId: 'ses_live', updatedAt: 20 }),
    ],
    'ses_live',
  );
  assert.deepEqual(result, { sessionId: 'ses_live', baseUrl: 'http://127.0.0.1:4096' });
});

test('resolveTaskOpenCodeSession falls back to the most recently updated registration', () => {
  const result = resolveTaskOpenCodeSession(
    [
      makeSession({ sessionId: 'ses_old', baseUrl: 'http://127.0.0.1:4096', updatedAt: 10 }),
      makeSession({ sessionId: 'ses_new', baseUrl: 'http://127.0.0.1:4100', updatedAt: 20 }),
    ],
    null,
  );
  assert.deepEqual(result, { sessionId: 'ses_new', baseUrl: 'http://127.0.0.1:4100' });
});

test('resolveTaskOpenCodeSession returns null when no registration exists', () => {
  const result = resolveTaskOpenCodeSession([], null);
  assert.equal(result, null);
});
