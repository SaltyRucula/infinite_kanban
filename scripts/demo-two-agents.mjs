#!/usr/bin/env node
/**
 * Two-agent end-to-end demo: one worker implements a task, a second worker
 * reviews it.
 *
 * Everything here is real except the task itself — a real board, two real
 * worker processes with distinct identities, real enrollment, real claim and
 * lease, real OpenCode agents doing the work, and the board's real review
 * path. The task is deliberately trivial so a pass/fail verdict is obvious.
 *
 * The handoff is driven by `assignedWorkerId`, which is how the board targets
 * a specific worker: the implementer is assigned the task, and once the card
 * lands in `review` the task is reassigned to the reviewer and run again. A
 * run started from the Review column carries `mode: 'review'`, which is what
 * puts the second agent in review mode with edits disabled.
 *
 * Usage:
 *   node scripts/demo-two-agents.mjs [boardUrl]
 *
 * Requires: a running board, `opencode` on PATH with an authenticated
 * provider, and Node 22+ (the board's own requirement).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

const execFile = promisify(execFileCb);
const BOARD = (process.argv[2] ?? process.env.BOARD_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
// A real agent run is minutes, not seconds; a review run is shorter.
const IMPLEMENT_TIMEOUT_MS = 12 * 60_000;
const REVIEW_TIMEOUT_MS = 8 * 60_000;
const WORKER_ONLINE_TIMEOUT_MS = 90_000;

const children = [];
const workerFailures = [];
let scratch;

function assertWorkersAlive(phase) {
  if (workerFailures.length > 0) {
    throw new Error(`worker process died before ${phase}: ${workerFailures.join('; ')}`);
  }
}

function log(step, detail = '') {
  console.log(`\n\x1b[36m▸ ${step}\x1b[0m${detail ? ` ${detail}` : ''}`);
}
function detail(msg) { console.log(`  ${msg}`); }

async function api(method, pathname, body) {
  const res = await fetch(`${BOARD}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> ${res.status} ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Each worker runs an OpenCode session bridge on its own port. Hardcoding
 * ports made the demo fail in a genuinely confusing way: a leftover worker
 * from an earlier run still held the port, the new worker died on
 * EADDRINUSE, nothing ever claimed the task, and the board's stranded-task
 * sweep failed the run minutes later with an empty event list. Asking the OS
 * for a free port removes that whole failure mode.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => { resolve(port); });
    });
  });
}

/** Poll until `predicate(value)` holds, or throw with the last value seen. */
async function waitFor(what, load, predicate, timeoutMs, onTick) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await load();
    if (predicate(last)) return last;
    if (onTick) onTick(last);
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${what}; last state: ${JSON.stringify(last)}`);
}

async function git(cwd, ...args) {
  const { stdout } = await execFile('git', args, { cwd });
  return stdout.trim();
}

/**
 * The demo must not touch the user's repositories, so the agents work in a
 * throwaway git repo. A real commit history exists so a reviewer has
 * something to diff against.
 */
async function createScratchRepo() {
  const dir = path.join(scratch, 'repo');
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'demo@example.com');
  await git(dir, 'config', 'user.name', 'Agent Board Demo');
  await writeFile(path.join(dir, 'README.md'), '# Demo repository\n\nA throwaway repository for the two-agent demo.\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'chore: initial commit');
  return dir;
}

async function startWorker({ label, name, workspacePath, bridgePort, projectId, acceptedLabel }) {
  const home = path.join(scratch, `worker-${label}`);
  await mkdir(home, { recursive: true });
  const { code } = await api('POST', '/api/workers/enrollment-codes', {});
  const enrollUrl = `${BOARD}/api/workers/enroll#${encodeURIComponent(code)}`;

  const child = spawn(process.execPath, [
    path.join(REPO_ROOT, 'packages/worker/dist/cli.js'),
    'start',
    '--code', enrollUrl,
    '--name', name,
    '--workspacePath', workspacePath,
    '--agentTypes', 'opencode',
    '--runner', 'opencode-server',
    '--agent', 'build',
    // Consent is explicit: a worker only accepts a task whose project it has
    // opted into and all of whose labels it has opted into. Giving the two
    // workers different labels is what makes the handoff a real handoff
    // rather than a race between two eligible workers.
    '--accepted-project-ids', projectId,
    '--accepted-labels', acceptedLabel,
  ], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Each worker needs its own identity directory. Without this the second
      // worker would overwrite the first one's credentials (see cli.ts).
      AGENTBOARD_WORKER_HOME: home,
      OPENCODE_SESSION_BRIDGE_PORT: String(bridgePort),
    },
  });
  children.push(child);

  const logPath = path.join(scratch, `worker-${label}.log`);
  const append = (chunk) => { void writeFile(logPath, chunk, { flag: 'a' }).catch(() => {}); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  // A worker that dies leaves the task unclaimed, and the board only reacts
  // minutes later via the stranded-task sweep. Surface it immediately.
  child.on('exit', (code_) => {
    detail(`\x1b[31mworker ${label} exited with code ${code_}\x1b[0m (log: ${logPath})`);
    if (code_ !== 0) workerFailures.push(`${label} exited with code ${code_}; see ${logPath}`);
  });

  detail(`worker ${label} starting — identity ${home}, log ${logPath}`);
  return { child, logPath };
}

async function findWorker(name) {
  const workers = await api('GET', '/api/workers');
  const list = Array.isArray(workers) ? workers : workers?.workers ?? [];
  return list.find((w) => w.name === name);
}

/**
 * There is no `GET /api/tasks/:id` — only `/:id/status`, which omits the
 * review verdict and summary. The board's list endpoint returns full tasks,
 * so the demo reads the card from there.
 */
async function loadTask(projectId, taskId) {
  const tasks = await api('GET', `/api/tasks?projectId=${encodeURIComponent(projectId)}`);
  const list = Array.isArray(tasks) ? tasks : tasks?.tasks ?? [];
  const found = list.find((t) => t.id === taskId);
  if (!found) throw new Error(`task ${taskId} not found in project ${projectId}`);
  return found;
}

function describeTask(task) {
  return `column=${task.columnId} agentStatus=${task.agentStatus}`;
}

/**
 * The board does not persist a `reviewVerdict` field. A review run reports its
 * verdict in the event stream as `REVIEW_VERDICT: <verdict>`, so that is where
 * the verdict is read from.
 *
 * Note the card does NOT reliably leave the Review column: `changes_requested`
 * moves it back to In Progress, but a `pass` leaves it in Review for a human to
 * take to Done. Waiting on a column change therefore hangs on the happy path.
 */
async function readVerdict(taskId) {
  const events = await api('GET', `/api/tasks/${taskId}/events`);
  const list = Array.isArray(events) ? events : events?.events ?? [];
  // Join with a space: event contents are arbitrary fragments and
  // concatenating them directly welds the verdict to the next event's text
  // ("pass" + "Review passed…" -> "passreview").
  const joined = list.map((e) => String(e.content ?? '')).join(' ');
  const match = /REVIEW_VERDICT:\s*(pass|fail|changes_requested|approved)\b/i.exec(joined.replace(/\s+/g, ' '));
  return match ? match[1].toLowerCase() : undefined;
}

async function printEvents(taskId, heading) {
  const events = await api('GET', `/api/tasks/${taskId}/events`);
  const list = Array.isArray(events) ? events : events?.events ?? [];
  log(heading, `(${list.length} events)`);
  for (const ev of list.slice(-12)) {
    const content = String(ev.content ?? '').replace(/\s+/g, ' ').slice(0, 160);
    detail(`[${ev.type}] ${content}`);
  }
}

async function cleanup() {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  // Give the workers a moment to release their claims before the process exits.
  await sleep(1500);
  for (const child of children) {
    if (!child.killed) child.kill('SIGKILL');
  }
}

async function main() {
  scratch = await mkdtemp(path.join(tmpdir(), 'agentboard-two-agent-'));
  log('Scratch directory', scratch);

  log('Checking the board', BOARD);
  const health = await api('GET', '/api/health');
  detail(`health: ${JSON.stringify(health)}`);

  log('Creating a throwaway git repository');
  const repoPath = await createScratchRepo();
  detail(repoPath);

  log('Creating the demo project');
  const project = await api('POST', '/api/projects', {
    name: `two-agent-demo-${Date.now()}`,
    repoPath,
    defaultAgentType: 'opencode',
  });
  detail(`project ${project.id} (${project.name})`);

  log('Enrolling two workers');
  const implementerName = `demo-implementer-${Date.now()}`;
  const reviewerName = `demo-reviewer-${Date.now()}`;
  await startWorker({ label: 'implementer', name: implementerName, workspacePath: repoPath, bridgePort: await freePort(), projectId: project.id, acceptedLabel: 'implement' });
  await startWorker({ label: 'reviewer', name: reviewerName, workspacePath: repoPath, bridgePort: await freePort(), projectId: project.id, acceptedLabel: 'review' });

  const implementer = await waitFor('the implementer to come online',
    () => findWorker(implementerName), (w) => w?.status === 'online', WORKER_ONLINE_TIMEOUT_MS);
  const reviewer = await waitFor('the reviewer to come online',
    () => findWorker(reviewerName), (w) => w?.status === 'online', WORKER_ONLINE_TIMEOUT_MS);
  detail(`implementer ${implementer.id} online`);
  detail(`reviewer    ${reviewer.id} online`);

  assertWorkersAlive('the task could be dispatched');

  log('Creating the task, assigned to the implementer');
  const task = await api('POST', '/api/tasks', {
    title: 'Add a greet.sh script that prints a fixed greeting',
    description: [
      'In the repository root, create an executable shell script named `greet.sh`.',
      'When run it must print exactly this single line:',
      '',
      '    Hello from the Agent Board',
      '',
      'Then commit the change. Do not modify any other file.',
    ].join('\n'),
    projectId: project.id,
    priority: 'high',
    agentType: 'opencode',
    labels: ['implement'],
  });
  // Task creation does not accept `assignedWorkerId`; it is a PATCH-only
  // field, so the assignment is a second call.
  await api('PATCH', `/api/tasks/${task.id}`, { assignedWorkerId: implementer.id });
  detail(`task ${task.id} assigned to the implementer`);

  log('Requesting the implementation run');
  await api('POST', `/api/tasks/${task.id}/run`, {});
  const implemented = await waitFor('the implementation to finish',
    () => loadTask(project.id, task.id),
    (t) => t.columnId === 'review' || t.agentStatus === 'complete' || t.agentStatus === 'failed',
    IMPLEMENT_TIMEOUT_MS,
    (t) => detail(`… ${describeTask(t)}`));
  detail(`implementation settled: ${describeTask(implemented)}`);
  await printEvents(task.id, 'Implementation events (last 12)');

  log('Git state after the implementer');
  detail(`log:   ${await git(repoPath, 'log', '--oneline', '-3').catch((e) => e.message)}`);
  detail(`files: ${await git(repoPath, 'ls-files').catch((e) => e.message)}`);

  if (implemented.agentStatus === 'failed') {
    throw new Error('the implementation run failed; see the events above');
  }

  // The reviewer has been idle while the implementer worked. If it dropped
  // out in the meantime the board's sweep would fail the review run with no
  // events, which is confusing to debug — so check first and say so plainly.
  log('Checking the reviewer is still online');
  const reviewerNow = await findWorker(reviewerName);
  if (reviewerNow?.status !== 'online') {
    throw new Error(`the reviewer is ${reviewerNow?.status ?? 'missing'} after idling through the implementation run; see its log in ${scratch}`);
  }
  detail(`reviewer still online (last heartbeat ${new Date(reviewerNow.lastHeartbeatAt).toISOString()})`);

  log('Handing the task to the reviewer');
  // Relabelling and reassigning in one call: the consent check runs against
  // the labels the task will have, so `review` must replace `implement` here
  // or the reviewer would be refused.
  await api('PATCH', `/api/tasks/${task.id}`, { assignedWorkerId: reviewer.id, labels: ['review'] });
  detail(`reassigned to ${reviewer.id} and relabelled 'review'`);

  log('Requesting the review run');
  await api('POST', `/api/tasks/${task.id}/run`, {});
  // Two waits, because the implementation left the card at `complete`: first
  // see the review run actually start, otherwise the terminal check below
  // would match the previous run's status immediately.
  await waitFor('the review run to start',
    () => loadTask(project.id, task.id),
    (t) => t.agentStatus === 'planning' || t.agentStatus === 'executing',
    60_000,
    (t) => detail(`… waiting for the reviewer to claim: ${describeTask(t)}`));
  const reviewed = await waitFor('the review to finish',
    () => loadTask(project.id, task.id),
    (t) => t.agentStatus === 'complete' || t.agentStatus === 'failed',
    REVIEW_TIMEOUT_MS,
    (t) => detail(`… ${describeTask(t)}`));
  detail(`review settled: ${describeTask(reviewed)}`);
  const verdict = await readVerdict(task.id);
  await printEvents(task.id, 'Review events (last 12)');

  log('Result');
  console.log(`  task          ${task.id}`);
  console.log(`  implementer   ${implementerName} (${implementer.id})`);
  console.log(`  reviewer      ${reviewerName} (${reviewer.id})`);
  console.log(`  final column  ${reviewed.columnId}`);
  console.log(`  agent status  ${reviewed.agentStatus}`);
  console.log(`  verdict       ${verdict ?? '(none reported)'}`);
  console.log(`  summary       ${String(reviewed.summary ?? '').replace(/\s+/g, ' ').slice(0, 140) || '(none)'}`);
  console.log(`  repository    ${repoPath}`);
  console.log(`  board card    ${BOARD.replace('8080', '8081')}/board`);
  console.log(`\n  Worker logs and the scratch repo are kept at ${scratch}`);
}

main()
  .then(() => cleanup())
  .then(() => { process.exit(0); })
  .catch(async (err) => {
    console.error(`\n\x1b[31m✖ demo failed:\x1b[0m ${err.message}`);
    if (scratch) console.error(`  worker logs: ${scratch}`);
    await cleanup();
    process.exit(1);
  });
