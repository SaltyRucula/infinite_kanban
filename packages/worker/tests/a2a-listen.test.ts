import assert from 'node:assert/strict';
import test from 'node:test';
import { parseA2AListenOptions } from '../src/a2a-listen.js';

test('A2A listener options default to loopback and reject invalid ports', () => {
  assert.deepEqual(parseA2AListenOptions({}), { host: '127.0.0.1', port: 0 });
  assert.deepEqual(parseA2AListenOptions({ host: '127.0.0.1', port: '4567' }), { host: '127.0.0.1', port: 4567 });
  assert.throws(() => parseA2AListenOptions({ port: '70000' }), /port must be an integer between 0 and 65535/);
});

test('A2A listener options reject URL-shaped hosts before binding', () => {
  assert.throws(
    () => parseA2AListenOptions({ host: 'http://0.0.0.0' }),
    /host must be a hostname or IP address without a URL scheme or port/,
  );
});

test('A2A listener options reject an unspecified bind address that cannot be advertised as a dialable worker endpoint', () => {
  assert.throws(
    () => parseA2AListenOptions({ host: '0.0.0.0', port: '8080' }),
    /host must be a specific hostname or IP address, not an unspecified bind address/,
  );
});

test('A2A listener options reject hosts with an embedded port', () => {
  assert.throws(
    () => parseA2AListenOptions({ host: 'worker.example.test:8080' }),
    /host must be a hostname or IP address without a URL scheme or port/,
  );
});
