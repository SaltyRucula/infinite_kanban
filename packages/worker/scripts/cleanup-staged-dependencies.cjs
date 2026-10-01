const fs = require('node:fs/promises');
const path = require('node:path');

const packageDir = path.resolve(__dirname, '..');

async function main() {
  await fs.rm(path.join(packageDir, 'node_modules', '@ai-agent-board', 'shared'), { recursive: true, force: true });
  await fs.rm(path.join(packageDir, 'node_modules', '@ai-agent-board', 'opencode-compat'), { recursive: true, force: true });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
