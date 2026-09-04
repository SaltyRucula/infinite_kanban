import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveTaskOpenCodeSession,
  type OpenCodeSessionClient,
  type OpenCodeSessionLike,
} from '../src/opencode/session-resolver.js';

function makeSession(overrides: Partial<OpenCodeSessionLike> = {}): OpenCodeSessionLike {
  return {
    id: 'ses_1',
    title: 'task-1',
    directory: '/repo',
    time: { updated: 1 },
    ...overrides,
  };
}

test('resolveTaskOpenCodeSession prefers the live session and fetches its directory', async () => {
  const client: OpenCodeSessionClient = {
    session: {
      async get({ path }) {
        assert.equal(path.id, 'ses_live');
        return { data: makeSession({ id: 'ses_live', directory: '/live/dir' }) };
      },
      async list() {
        throw new Error('list should not be called when a live session resolves');
      },
    },
  };

  const result = await resolveTaskOpenCodeSession(client, 'task-1', 'ses_live');
  assert.deepEqual(result, { sessionId: 'ses_live', directory: '/live/dir' });
});

test('resolveTaskOpenCodeSession falls back to the most recently updated session matching the task title', async () => {
  const client: OpenCodeSessionClient = {
    session: {
      async get() {
        return { data: undefined };
      },
      async list() {
        return {
          data: [
            makeSession({ id: 'ses_old', title: 'task-1', time: { updated: 10 }, directory: '/old' }),
            makeSession({ id: 'ses_new', title: 'task-1', time: { updated: 20 }, directory: '/new' }),
            makeSession({ id: 'ses_other', title: 'task-2', time: { updated: 30 }, directory: '/other' }),
          ],
        };
      },
    },
  };

  const result = await resolveTaskOpenCodeSession(client, 'task-1', null);
  assert.deepEqual(result, { sessionId: 'ses_new', directory: '/new' });
});

test('resolveTaskOpenCodeSession returns null when no session matches', async () => {
  const client: OpenCodeSessionClient = {
    session: {
      async get() {
        return { data: undefined };
      },
      async list() {
        return { data: [] };
      },
    },
  };

  const result = await resolveTaskOpenCodeSession(client, 'task-1', null);
  assert.equal(result, null);
});
