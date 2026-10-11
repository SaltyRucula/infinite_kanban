import assert from 'node:assert/strict';
import test from 'node:test';
import { redactProgressContent } from '../src/harness-registry.js';

/**
 * Redaction matches environment variables by NAME and removes their VALUE from
 * the text. A short value is not a credential, and removing it everywhere
 * destroys the progress log it was meant to protect.
 */
test('a short environment value is not treated as a secret', () => {
  const previous = process.env.API_KEY_ENABLED;
  process.env.API_KEY_ENABLED = 'true';
  try {
    assert.equal(redactProgressContent('tests passed: true'), 'tests passed: true');
  } finally {
    if (previous === undefined) delete process.env.API_KEY_ENABLED; else process.env.API_KEY_ENABLED = previous;
  }
});

test('a credential-length environment value is still removed', () => {
  const previous = process.env.DEMO_TOKEN;
  process.env.DEMO_TOKEN = 'abcdef0123456789abcdef';
  try {
    assert.match(redactProgressContent('using abcdef0123456789abcdef now'), /\[redacted\]/);
    assert.doesNotMatch(redactProgressContent('using abcdef0123456789abcdef now'), /abcdef0123456789/);
  } finally {
    if (previous === undefined) delete process.env.DEMO_TOKEN; else process.env.DEMO_TOKEN = previous;
  }
});

test('structured secrets are removed regardless of length', () => {
  for (const sample of ['Authorization: Bearer xyz', 'token="s3"', 'ghp_abcdefghijklmnop']) {
    assert.match(redactProgressContent(sample), /\[redacted\]/, sample);
  }
});
