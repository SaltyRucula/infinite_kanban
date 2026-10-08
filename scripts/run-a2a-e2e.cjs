const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const playwright = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', '.bin', 'playwright.cmd')
  : path.join(repoRoot, 'node_modules', '.bin', 'playwright');

const result = spawnSync(playwright, ['test', '--config=playwright.a2a.config.ts', '--reporter=list'], {
  cwd: path.join(repoRoot, 'packages', 'e2e'),
  env: { ...process.env, E2E_A2A_FIRST_UI: 'true' },
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);