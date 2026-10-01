import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workersDocs = new URL('../../../docs/workers.md', import.meta.url);

test('worker onboarding documentation describes the one-command enrollment flow', async () => {
  const docs = await readFile(workersDocs, 'utf8');

  assert.match(docs, /Add worker/i);
  assert.match(docs, /enrollment code/i);
  assert.match(docs, /npx @ai-agent-board\/worker start --code <enrollment-url>/);
  assert.match(docs, /Node\.js 22\+/);
  assert.match(docs, /opencode auth login/);
  assert.match(docs, /(do not need to edit|no hand-editing) JSON/i);
  assert.match(docs, /runner block/i);
});
