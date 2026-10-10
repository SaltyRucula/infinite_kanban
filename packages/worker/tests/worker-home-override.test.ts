import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cliSource = new URL('../src/cli.ts', import.meta.url);
const workersDocs = new URL('../../../docs/workers.md', import.meta.url);

/**
 * `cli.ts` resolves its paths once at module load, so the override cannot be
 * re-tested by re-importing with a different environment inside one process.
 * These tests pin the behaviour that matters — the override is read, it wins
 * over the home directory, and the fallback is unchanged — by driving the
 * same resolution rule the module uses.
 */
function resolveWorkerHome(env: Record<string, string | undefined>, homedir: string): string {
  return env.AGENTBOARD_WORKER_HOME?.trim() || path.join(homedir, '.agentboard-worker');
}

test('AGENTBOARD_WORKER_HOME overrides the default identity directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'worker-home-'));
  assert.equal(resolveWorkerHome({ AGENTBOARD_WORKER_HOME: dir }, '/Users/example'), dir);
});

test('a blank or unset override falls back to the home directory', () => {
  assert.equal(
    resolveWorkerHome({}, '/Users/example'),
    path.join('/Users/example', '.agentboard-worker'),
  );
  // A whitespace-only value is a configuration mistake, not a request to put
  // worker credentials in the filesystem root.
  assert.equal(
    resolveWorkerHome({ AGENTBOARD_WORKER_HOME: '   ' }, '/Users/example'),
    path.join('/Users/example', '.agentboard-worker'),
  );
});

test('the CLI derives both credential files from the override, not from homedir directly', async () => {
  const source = await readFile(cliSource, 'utf8');

  // Guards the regression that let two workers on one host share an identity
  // directory: either path going back to os.homedir() silently reintroduces it.
  assert.match(source, /AGENTBOARD_WORKER_HOME/);
  assert.match(source, /const configPath = path\.join\(workerHome, 'config\.json'\)/);
  assert.match(source, /const workspaceConfigPath = path\.join\(workerHome, 'workspace\.json'\)/);
});

test('running several workers on one machine is documented', async () => {
  const docs = await readFile(workersDocs, 'utf8');

  assert.match(docs, /AGENTBOARD_WORKER_HOME/);
  // The HOME dead end cost real debugging time; keep the warning in the docs.
  assert.match(docs, /Setting `HOME` instead does not work/i);
  assert.match(docs, /OPENCODE_SESSION_BRIDGE_PORT/);
});
