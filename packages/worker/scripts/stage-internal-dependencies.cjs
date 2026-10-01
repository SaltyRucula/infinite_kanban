const fs = require('node:fs/promises');
const path = require('node:path');

const packageDir = path.resolve(__dirname, '..');
const internalPackages = [
  { name: 'shared', source: path.resolve(packageDir, '..', '..', 'shared') },
  { name: 'opencode-compat', source: path.resolve(packageDir, '..', 'opencode-compat') },
];

async function main() {
  for (const { name, source } of internalPackages) {
    const destination = path.join(packageDir, 'node_modules', '@ai-agent-board', name);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(source, destination, {
      recursive: true,
      filter: (entry) => !entry.includes(`${path.sep}node_modules${path.sep}`),
    });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
