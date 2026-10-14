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

// The three private, unpublished workspace packages the worker is built from
// (@ai-agent-board/shared, @ai-agent-board/a2a, @ai-agent-board/opencode-compat)
// must never appear as installable dependencies: nothing publishes them, so a
// standalone `npm install @ai-agent-board/worker` would 404 trying to resolve
// them. The build inlines their source into dist/*.js instead (see
// scripts/bundle.mjs), so they must be absent from "dependencies" too.
test('worker package does not declare the inlined workspace packages as runtime dependencies', async () => {
  const pkg = await readWorkerPackage();
  const dependencies = Object.keys((pkg.dependencies ?? {}) as Record<string, unknown>);

  for (const workspacePackage of ['@ai-agent-board/shared', '@ai-agent-board/a2a', '@ai-agent-board/opencode-compat']) {
    assert.ok(
      !dependencies.includes(workspacePackage),
      `${workspacePackage} is bundled into dist, not an installable dependency`,
    );
  }
});

// Genuine npm dependencies stay external to the bundle (see scripts/bundle.mjs
// EXTERNAL list) and must still be declared so an installer resolves them.
test('worker package still declares its real npm runtime dependencies', async () => {
  const pkg = await readWorkerPackage();
  const dependencies = Object.keys((pkg.dependencies ?? {}) as Record<string, unknown>);

  for (const externalPackage of [
    '@a2a-js/sdk',
    '@codewithdan/agent-sdk-core',
    '@openai/codex-sdk',
    '@opencode-ai/sdk',
    'express',
    'uuid',
  ]) {
    assert.ok(dependencies.includes(externalPackage), `${externalPackage} must stay a declared dependency`);
  }
});
