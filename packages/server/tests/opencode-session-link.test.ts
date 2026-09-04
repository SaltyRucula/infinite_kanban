import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenCodeSessionUrl } from '../src/opencode/session-link.js';

test('buildOpenCodeSessionUrl encodes the session directory and appends the session id', () => {
  const url = buildOpenCodeSessionUrl(
    'http://127.0.0.1:4096',
    '/Users/ctw01561/Projects/ai-agent-board',
    'ses_fa3ca72cdffeHGxuWARy3ILL8V',
  );
  assert.equal(
    url,
    'http://127.0.0.1:4096/L1VzZXJzL2N0dzAxNTYxL1Byb2plY3RzL2FpLWFnZW50LWJvYXJk/session/ses_fa3ca72cdffeHGxuWARy3ILL8V',
  );
});

test('buildOpenCodeSessionUrl strips a trailing slash from the base URL', () => {
  const url = buildOpenCodeSessionUrl('http://127.0.0.1:4096/', '/tmp/repo', 'ses_1');
  assert.equal(url, `http://127.0.0.1:4096/${Buffer.from('/tmp/repo', 'utf8').toString('base64')}/session/ses_1`);
});
