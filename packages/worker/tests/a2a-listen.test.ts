import assert from 'node:assert/strict';
import test from 'node:test';
import { parseA2AListenOptions } from '../src/a2a-listen.js';

test('A2A listener options default to loopback and reject invalid ports', () => {
  assert.deepEqual(parseA2AListenOptions({}), { host: '127.0.0.1', port: 0 });
  assert.deepEqual(parseA2AListenOptions({ host: '127.0.0.1', port: '4567' }), { host: '127.0.0.1', port: 4567 });
  assert.throws(() => parseA2AListenOptions({ port: '70000' }), /port must be an integer between 0 and 65535/);
});
