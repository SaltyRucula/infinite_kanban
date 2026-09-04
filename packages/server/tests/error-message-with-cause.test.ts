import assert from 'node:assert/strict';
import test from 'node:test';
import { errorMessageWithCause } from '../src/utils.js';

test('errorMessageWithCause appends the full cause chain for a wrapped fetch failure', () => {
  const rootCause = new Error('connect ECONNREFUSED 127.0.0.1:4096');
  const wrapped = new Error('fetch failed', { cause: rootCause });
  assert.equal(
    errorMessageWithCause(wrapped),
    'fetch failed (caused by: connect ECONNREFUSED 127.0.0.1:4096)',
  );
});

test('errorMessageWithCause returns the plain message when there is no cause', () => {
  assert.equal(errorMessageWithCause(new Error('plain failure')), 'plain failure');
});

test('errorMessageWithCause walks multiple levels of nested causes', () => {
  const root = new Error('socket hang up');
  const middle = new Error('fetch failed', { cause: root });
  const outer = new Error('createSession failed', { cause: middle });
  assert.equal(
    errorMessageWithCause(outer),
    'createSession failed (caused by: fetch failed (caused by: socket hang up))',
  );
});

test('errorMessageWithCause falls back to String() for a non-Error value', () => {
  assert.equal(errorMessageWithCause('plain string'), 'plain string');
});
