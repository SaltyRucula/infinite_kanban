import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// Regression guard for the stale-dist hazard. tsc -b is emitDeclarationOnly
// here, so it never overwrites .js files left behind by an earlier build that
// did emit per-file runtime output, and esbuild only writes its own entry
// points and chunks. Without an explicit clean, such a file survives in dist
// still carrying a raw @ai-agent-board/* specifier — and files:["dist"]
// publishes it, which is exactly the broken-on-install package the bundler
// exists to prevent.
//
// The packed-tarball test cannot catch this: prepack runs the build, so on a
// clean checkout the tarball is clean whether or not the bundler cleans, and
// the failure would only ever reproduce on a developer or CI tree that
// happened to already be dirty.
test('the bundler removes stale runtime JS left in dist by an earlier build', async () => {
  const distDir = path.join(packageDir, 'dist');
  await fs.mkdir(distDir, { recursive: true });

  const stalePath = path.join(distDir, 'stale-from-an-older-build.js');
  await fs.writeFile(stalePath, "export * from '@ai-agent-board/shared/types.js';\n");

  execFileSync(process.execPath, ['scripts/bundle.mjs'], { cwd: packageDir, stdio: 'pipe' });

  await assert.rejects(
    fs.access(stalePath),
    'stale runtime JS from an earlier build must not survive a rebuild',
  );

  for (const name of (await fs.readdir(distDir)).filter((entry) => entry.endsWith('.js'))) {
    const contents = await fs.readFile(path.join(distDir, name), 'utf8');
    assert.ok(
      !contents.includes('@ai-agent-board/'),
      `dist/${name} must not ship a raw workspace import specifier`,
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
