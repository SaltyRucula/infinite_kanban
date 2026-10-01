import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

async function readWorkerPackage(): Promise<Record<string, unknown>> {
  const packageUrl = new URL('../package.json', import.meta.url);
  return JSON.parse(await fs.readFile(packageUrl, 'utf8')) as Record<string, unknown>;
}

test('worker package exposes a public npx executable from its built CLI', async () => {
  const pkg = await readWorkerPackage();

  assert.notEqual(pkg.private, true, 'a private package cannot be installed through npx');
  assert.deepEqual(pkg.bin, { 'agentboard-worker': 'dist/cli.js' });
  assert.deepEqual(pkg.files, ['dist']);
});

test('worker package declares bundled internal runtime dependencies for standalone npx installs', async () => {
  const pkg = await readWorkerPackage();

  assert.deepEqual(pkg.bundleDependencies, [
    '@ai-agent-board/opencode-compat',
    '@ai-agent-board/shared',
  ]);
});
