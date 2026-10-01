import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

test('packed worker bundles internal runtime dependencies for standalone npx installs', async () => {
  const packageDir = path.dirname(new URL('../package.json', import.meta.url).pathname);
  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-worker-pack-'));
  try {
    const { stdout } = await execFile('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: packageDir });
    const packed = JSON.parse(stdout) as Array<{ filename: string }>;
    const { stdout: contents } = await execFile('tar', ['-tzf', path.join(packDir, packed[0]?.filename ?? '')]);

    assert.match(contents, /package\/node_modules\/@ai-agent-board\/shared\/package\.json/);
    assert.match(contents, /package\/node_modules\/@ai-agent-board\/opencode-compat\/package\.json/);
  } finally {
    await fs.rm(packDir, { recursive: true, force: true });
  }
});
