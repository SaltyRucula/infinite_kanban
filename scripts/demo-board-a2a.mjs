#!/usr/bin/env node
/**
 * The end-to-end demo for the board-owned workflow.
 *
 *   node scripts/demo-board-a2a.mjs                         # private throwaway board
 *   node scripts/demo-board-a2a.mjs http://127.0.0.1:8080   # your running board, watchable in the UI
 *
 * It proves the architecture rather than describing it: the board assigns
 * implementation, an endpoint returns a commit plus evidence, the board
 * independently assigns review of that exact commit to a *different* endpoint,
 * and the card only reaches Done after an explicit human approval.
 *
 * Nothing here selects a harness on the board's behalf. Each endpoint is
 * configured locally with its own harness; the task only asks for a role.
 *
 * Harness selection is endpoint configuration:
 *   DEMO_IMPLEMENTATION_HARNESS / DEMO_REVIEW_HARNESS   opencode | codex
 *   DEMO_OPENCODE_MODEL / DEMO_CODEX_MODEL              endpoint-local model
 */
import { mkdtemp, mkdir, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startExecutionEndpoint } from '../packages/worker/dist/execution-endpoint.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const boardArgument = process.argv[2];
const implementationHarness = process.env.DEMO_IMPLEMENTATION_HARNESS ?? 'opencode';
const reviewHarness = process.env.DEMO_REVIEW_HARNESS ?? 'opencode';
for (const harness of [implementationHarness, reviewHarness]) {
  if (!['opencode', 'codex'].includes(harness)) throw new Error(`Unsupported harness: ${harness}`);
}

const step = (text) => console.log(`\n\u25b8 ${text}`);
const detail = (text) => console.log(`  ${text}`);
const fail = (text) => console.log(`\n\u2716 ${text}`);

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const scratch = await mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'board-a2a-demo-'));
const fixture = path.join(scratch, 'fixture');
await mkdir(fixture);
const git = (...args) => execFileSync('git', args, { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** The board never receives this local path; each endpoint maps the identity itself. */
const repository = 'https://github.com/board-demo/add';
const report = { artifactDirectory: scratch, implementationHarness, reviewHarness, repository };
const endpoints = [];
let board;

try {
  step(`Scratch directory\n  ${scratch}`);

  step('Creating a throwaway git repository with a deliberate bug');
  git('init', '-b', 'main');
  git('config', 'user.name', 'A2A demo');
  git('config', 'user.email', 'demo@localhost');
  await writeFile(path.join(fixture, 'add.cjs'), 'module.exports = (a, b) => a - b;\n');
  await writeFile(
    path.join(fixture, 'add.test.cjs'),
    "const test=require('node:test'),assert=require('node:assert/strict'),add=require('./add.cjs');\n"
    + "test('adds positive and negative values',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1)});\n",
  );
  git('add', '.');
  git('commit', '-m', 'demo fixture');
  const baseRevision = git('rev-parse', 'HEAD');
  report.baseRevision = baseRevision;
  detail(`add.cjs subtracts instead of adding; base commit ${baseRevision.slice(0, 12)}`);

  // Either drive the board the user is already watching, or start a private one.
  let base = boardArgument;
  if (base) {
    step(`Using the running board ${base}`);
    const health = await fetch(new URL('/api/health', base)).catch(() => undefined);
    if (!health?.ok) throw new Error(`no board is answering at ${base}; start it, or omit the argument`);
    detail(`health: ${(await health.text()).trim()}`);
  } else {
    step('Starting a private throwaway board');
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const logPath = path.join(scratch, 'board.log');
    const log = await open(logPath, 'w');
    board = spawn(process.execPath, ['dist/index.js'], {
      cwd: path.join(repoRoot, 'packages/server'),
      env: {
        ...process.env,
        PORT: String(port), HOST: '127.0.0.1',
        DATABASE_URL: '', API_KEY: '', SERVICE_TOKENS: '',
        DB_PATH: path.join(scratch, 'board.db'),
        AGENTBOARD_HOME: path.join(scratch, 'board-home'),
        DOTENV_CONFIG_PATH: path.join(scratch, 'no-env'),
        AGENTBOARD_DISABLE_AGENT_STARTUP: '1',
      },
      stdio: ['ignore', log.fd, log.fd],
    });
    await log.close();
    for (let attempt = 0; ; attempt++) {
      try { const probe = await fetch(`${base}/api/health`); if (probe.ok) break; } catch { /* starting */ }
      if (attempt === 99) throw new Error(`board failed to start; see ${logPath}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    detail(`${base} (log: ${logPath})`);
  }
  report.board = base;

  const api = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };

  step('Creating the demo project');
  const project = await api('/api/projects', 'POST', {
    name: `board-workflow-demo-${Date.now()}`,
    repoPath: fixture,
  });
  report.projectId = project.id;
  detail(`project ${project.id} (${project.name})`);

  // Two endpoints, each owning its own harness. The reviewer must be a distinct
  // identity: the board refuses to let an endpoint review its own work.
  step('Starting two execution endpoints');
  for (const [role, harness] of [['implementation', implementationHarness], ['review', reviewHarness]]) {
    const endpoint = await startExecutionEndpoint({
      harness,
      model: harness === 'opencode'
        ? (process.env.DEMO_OPENCODE_MODEL ?? 'github-copilot/gpt-6.1-sol')
        : process.env.DEMO_CODEX_MODEL,
      roles: [role],
      projects: [project.id],
      repositories: { [repository]: fixture },
      stateDirectory: path.join(scratch, role),
      capabilities: ['git:revision'],
      checks: [{ name: 'node-tests', command: process.execPath, args: ['--test', 'add.test.cjs'] }],
    }, { port: 0 });
    endpoints.push(endpoint);
    const registration = await api('/api/a2a-agents', 'POST', {
      agentCardUrl: `${endpoint.baseUrl}/.well-known/agent-card.json`,
    });
    await api(`/api/a2a-agents/${registration.id}/projects/${project.id}/roles`, 'PUT', { roles: [role] });
    detail(`${role.padEnd(14)} harness=${harness} endpoint=${endpoint.baseUrl}`);
    detail(`${''.padEnd(14)} board agent id ${registration.id}`);
  }

  step('Creating the task — it names a role, never a harness');
  const task = await api('/api/tasks', 'POST', {
    projectId: project.id,
    title: 'Fix integer addition',
    description: 'Correct add.cjs to add two numbers. Preserve CommonJS exports and pass the existing node:test fixture. Only change add.cjs.',
  });
  report.taskId = task.id;
  detail(`task ${task.id}`);
  if (boardArgument) detail(`watch it on the board: ${base.replace(':8080', ':8081')}/board`);

  step('Handing the task to the board-owned workflow');
  await api(`/api/tasks/${task.id}/workflow/run`, 'POST', {
    repository,
    baseRevision,
    requiredCapabilities: ['git:revision'],
    policy: { requiredChecks: ['node-tests'], deadline: Date.now() + 600_000 },
  });

  // Narrate the board's own decisions as they happen, not just the end state.
  const describe = (run) => run.assignments
    .map((dispatch) => `${dispatch.assignment.role}#${dispatch.assignment.attempt}:${dispatch.state}`)
    .join(' ');
  let run;
  let previous = '';
  for (let attempt = 0; attempt < 600; attempt++) {
    run = await api(`/api/tasks/${task.id}/workflow`);
    const line = `phase=${run.phase} ${describe(run)}`;
    if (line !== previous) { detail(line); previous = line; }
    if (['awaiting_approval', 'done', 'escalated', 'canceled'].includes(run.phase)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  report.workflow = run;
  await writeFile(path.join(scratch, 'report.json'), JSON.stringify(report, null, 2));
  if (run.phase !== 'awaiting_approval') {
    throw new Error(`workflow ended ${run.phase}: ${JSON.stringify(run.diagnostics)}`);
  }

  step('What each endpoint produced');
  const implementer = run.assignments.find((dispatch) => dispatch.assignment.role === 'implementation');
  const reviewer = run.assignments.find((dispatch) => dispatch.assignment.role === 'review');
  for (const dispatch of run.assignments) {
    const { role, attempt, endpointId, targetRevision } = dispatch.assignment;
    const { revision, summary, evidence, verdict, findings } = dispatch.result;
    detail(`${role} (attempt ${attempt}) on endpoint ${endpointId}`);
    if (targetRevision) detail(`  reviewed revision ${targetRevision}`);
    detail(`  produced revision ${revision}`);
    detail(`  summary: ${summary.replace(/\s+/g, ' ').slice(0, 150)}`);
    for (const item of evidence) detail(`  evidence ${item.check}: ${item.outcome}`);
    if (verdict) detail(`  structured verdict: ${verdict} (${findings.length} findings)`);
  }

  // Assertions that make this a proof instead of a narration.
  if (reviewer.assignment.endpointId === implementer.assignment.endpointId) {
    throw new Error('the reviewer was not an independent endpoint');
  }
  if (reviewer.assignment.targetRevision !== run.acceptedRevision) {
    throw new Error('the review subject was not the accepted revision');
  }

  step('Review approved — the board still requires a human decision');
  detail(`phase ${run.phase}, card is not Done yet`);
  detail(`accepted revision ${run.acceptedRevision}`);

  step('Approving the reviewed revision');
  await api(`/api/tasks/${task.id}/workflow/approve`, 'POST', { revision: run.acceptedRevision });
  report.workflow = await api(`/api/tasks/${task.id}/workflow`);
  report.task = (await api(`/api/tasks?projectId=${project.id}`)).find((candidate) => candidate.id === task.id);
  if (report.task.columnId !== 'done') throw new Error(`approval did not finish the card: ${report.task.columnId}`);
  await writeFile(path.join(scratch, 'report.json'), JSON.stringify(report, null, 2));

  step('Result');
  detail(`workflow        ${report.workflow.id}`);
  detail(`implementation  ${implementer.assignment.assignmentId} (${implementationHarness})`);
  detail(`review          ${reviewer.assignment.assignmentId} (${reviewHarness})`);
  detail(`accepted commit ${report.workflow.acceptedRevision}`);
  detail(`approved commit ${report.workflow.approvedRevision} by ${report.workflow.approvedBy}`);
  detail(`final column    ${report.task.columnId}`);
  detail(`repository      ${fixture}`);
  detail(`report          ${path.join(scratch, 'report.json')}`);
} catch (error) {
  fail(`demo failed: ${error instanceof Error ? error.message : error}`);
  fail(`evidence kept at ${scratch}`);
  process.exitCode = 1;
} finally {
  for (const endpoint of endpoints) await endpoint.close().catch(() => {});
  if (board && !board.killed) {
    board.kill('SIGTERM');
    await new Promise((resolve) => board.once('exit', resolve));
  }
}
