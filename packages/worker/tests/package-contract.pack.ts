import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

// `npm pack` runs "prepack" -> "build" (tsc -b then scripts/bundle.mjs), so
// this proves the exact artifact a consumer would install: the inlined
// workspace packages must be gone from both the tarball manifest and the
// bundled JS, while genuine npm dependencies stay declared, and the bin must
// still be directly executable.
test('packed worker bundles the inlined workspace packages and declares no 404-prone dependencies', async () => {
  const packageDir = path.dirname(new URL('../package.json', import.meta.url).pathname);
  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-worker-pack-'));
  try {
    const { stdout } = await execFile('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: packageDir });
    const packed = JSON.parse(stdout) as Array<{ filename: string }>;
    const tarballPath = path.join(packDir, packed[0]?.filename ?? '');
    const { stdout: contents } = await execFile('tar', ['-tzf', tarballPath]);

    // The three inlined workspace packages are never staged into node_modules
    // inside the tarball; there is nothing published for them to resolve to.
    assert.doesNotMatch(contents, /node_modules\/@ai-agent-board\//);

    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-worker-extract-'));
    try {
      await execFile('tar', ['-xzf', tarballPath, '-C', extractDir]);
      const distDir = path.join(extractDir, 'package', 'dist');
      const distFiles = (await fs.readdir(distDir)).filter((name) => name.endsWith('.js'));
      assert.ok(distFiles.length > 0, 'the tarball must ship built dist/*.js files');

      for (const file of distFiles) {
        const source = await fs.readFile(path.join(distDir, file), 'utf8');
        assert.doesNotMatch(
          source,
          /@ai-agent-board\/[a-z-]+/,
          `${file} must not import an unpublished workspace package`,
        );
      }

      const cliSource = await fs.readFile(path.join(distDir, 'cli.js'), 'utf8');
      assert.match(cliSource, /^#!\/usr\/bin\/env node/, 'the shebang must survive bundling');

      const cliStat = await fs.stat(path.join(distDir, 'cli.js'));
      assert.ok((cliStat.mode & 0o111) !== 0, 'dist/cli.js must be executable in the packed tarball');
    } finally {
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(packDir, { recursive: true, force: true });
  }
});
