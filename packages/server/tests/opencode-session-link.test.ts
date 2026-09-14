import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenCodeSessionUrl } from '../src/opencode/session-link.js';

test('buildOpenCodeSessionUrl appends the session id without encoding any local path', () => {
  const url = buildOpenCodeSessionUrl('http://127.0.0.1:4096', 'ses_fa3ca72cdffeHGxuWARy3ILL8V');
  assert.equal(url, 'http://127.0.0.1:4096/session/ses_fa3ca72cdffeHGxuWARy3ILL8V');
});

test('buildOpenCodeSessionUrl strips a trailing slash from the base URL', () => {
  const url = buildOpenCodeSessionUrl('http://127.0.0.1:4096/', 'ses_1');
  assert.equal(url, 'http://127.0.0.1:4096/session/ses_1');
});
