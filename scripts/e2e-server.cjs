const { mkdirSync, rmSync } = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const dbPath = path.join(repoRoot, 'packages', 'e2e', 'test-results', 'agentboard-e2e.db');
const agentboardHome = path.join(repoRoot, 'packages', 'e2e', 'test-results', 'agentboard-home');
function portFromEnv(name, fallback) {
  const value = process.env[name] || fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a numeric port`);
  }
  return value;
}
const serverPort = portFromEnv('E2E_SERVER_PORT', '3002');
const clientPort = portFromEnv('E2E_CLIENT_PORT', '4176');
const allowedRepoRoots = [
  repoRoot,
  process.env.TEMP,
  process.env.TMP,
  process.env.TMPDIR,
].filter(Boolean).join(',');

mkdirSync(path.dirname(dbPath), { recursive: true });
rmSync(dbPath, { force: true });
rmSync(agentboardHome, { recursive: true, force: true });
mkdirSync(agentboardHome, { recursive: true });

const child = spawn(isWindows ? 'npx tsx src/index.ts' : 'npx', isWindows ? [] : ['tsx', 'src/index.ts'], {
  cwd: path.join(repoRoot, 'packages', 'server'),
  env: {
    ...process.env,
    PORT: serverPort,
    DATABASE_URL: '',
    DB_PATH: dbPath,
    API_KEY: '',
    ALLOWED_ORIGINS: `http://localhost:${clientPort}`,
    ALLOWED_REPO_ROOTS: allowedRepoRoots,
    AGENTBOARD_HOME: agentboardHome,
    // dotenv (loaded by src/index.ts) fills in any var absent here from
    // packages/server/.env — without these overrides the e2e server picks
    // up real Jira credentials from that file and Jira-import specs would
    // silently call the real company Jira instead of a test's local fake
    // server (see git blame). jira-assigned-agent-automation-f3.spec.ts's
    // fake server listens on 127.0.0.1:3909; other specs mock at the
    // browser/route level and don't depend on this value.
    JIRA_BASE_URL: 'http://127.0.0.1:3909',
    JIRA_USER_EMAIL: 'e2e@example.com',
    JIRA_API_TOKEN: 'e2e-fake-token',
    JIRA_IS_DATACENTER: 'false',
    // E2E never runs real agents; skip booting agent SDK clients so an
    // unauthenticated environment can't crash the server on startup.
    AGENTBOARD_DISABLE_AGENT_STARTUP: '1',
    AGENTBOARD_E2E_CLARIFICATION_PROVIDER: '1',
  },
  shell: isWindows,
  stdio: 'inherit',
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
