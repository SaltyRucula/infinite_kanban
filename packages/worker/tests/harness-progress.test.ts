import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

test('real harness registry forwards provider and OpenCode progress', async (t) => {
  // Node's ESM dependency mocks need this flag. Keep it local to these tests;
  // only the SDK/adapter boundaries are mocked, never the registry or endpoint execute.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = await promisify(execFile)(process.execPath, [
    '--experimental-test-module-mocks', '--import', 'tsx/esm', '--test',
    fileURLToPath(new URL('./fixtures/harness-progress.ts', import.meta.url)),
  ], { timeout: 30_000, env }).catch((error: Error & { stdout?: string }) => {
    if (error.stdout) t.diagnostic(error.stdout);
    throw error;
  });
  assert.match(result.stdout, /# fail 0\b/, result.stdout);
  // A floor, not an exact count: adding a case should not fail this wrapper.
  const ran = Number(/# tests (\d+)/.exec(result.stdout)?.[1] ?? 0);
  assert.ok(ran >= 12, `expected at least 12 harness progress cases, ran ${ran}\n${result.stdout}`);
});
