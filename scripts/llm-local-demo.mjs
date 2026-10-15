#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SUPPORTED_HARNESSES = new Set(['opencode', 'codex']);

function usage() {
  return `Usage: npm run demo:llm -- [options]

Start a local Hermes agent with a bounded mission to prepare and run the
board-owned A2A demo. The agent uses existing local authentication only.

Options:
  --runner <executable>  LLM CLI to start (default: hermes)
  --harness <name>       Demo endpoint harness: opencode or codex (default: opencode)
  --board <url>          Use an already-running board instead of a private board
  --print-prompt         Print the safe handoff prompt without starting an LLM
  --dry-run              Print preflight and the runner invocation without starting it
  --help                 Show this help
`;
}

export function parseArguments(argv) {
  const options = {
    boardUrl: undefined,
    dryRun: false,
    harness: 'opencode',
    printPrompt: false,
    runner: 'hermes',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (option === '--print-prompt') {
      options.printPrompt = true;
      continue;
    }
    if (option === '--help') {
      return { ...options, help: true };
    }
    if (option === '--runner' || option === '--harness' || option === '--board') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
      index += 1;
      if (option === '--runner') options.runner = value;
      if (option === '--harness') options.harness = value;
      if (option === '--board') options.boardUrl = value;
      continue;
    }
    throw new Error(`Unknown option: ${option}`);
  }

  if (!SUPPORTED_HARNESSES.has(options.harness)) {
    throw new Error(`Unsupported harness: ${options.harness}. Use opencode or codex.`);
  }
  if (!options.runner || /\s|\0/.test(options.runner)) {
    throw new Error('--runner must be a single executable path or command name');
  }
  if (options.boardUrl) {
    let parsed;
    try {
      parsed = new URL(options.boardUrl);
    } catch {
      throw new Error('--board must be an absolute http(s) URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('--board must be an http(s) URL without embedded credentials');
    }
    options.boardUrl = parsed.toString().replace(/\/$/, '');
  }

  return options;
}

export function buildLlmDemoMission({ repoRoot, harness, boardUrl }) {
  const demoCommand = [
    `DEMO_IMPLEMENTATION_HARNESS=${harness}`,
    `DEMO_REVIEW_HARNESS=${harness}`,
    'node scripts/demo-board-a2a.mjs',
    ...(boardUrl ? [boardUrl] : []),
  ].join(' ');

  return `You are the local setup operator for Infinite Kanban. Work only inside:
${repoRoot}

Goal: prepare this checkout and run the board-owned A2A quick demo. It must prove implementation -> independent review -> explicit approval, and report the resulting artifact directory.

Safety boundaries:
- Never print, read, copy, or request secrets, credentials, auth files, tokens, or environment values.
- Use existing local authentication only. If the selected harness is not installed or authenticated, stop and report the exact blocker; do not attempt a login or workaround.
- Do not use sudo or a system package manager. Do not alter shell profiles, global Node installations, git remotes, or tracked source files.
- Do not push, commit, create pull requests, or modify board configuration outside the throwaway demo resources.

Procedure:
1. Inspect Node and npm versions. The production agent SDK requires Node 22 or newer. If the active Node runtime is older or unhealthy, stop and report that fact without replacing it.
2. Install project dependencies with: npm ci --include=dev
3. Build only the demo prerequisites in this order:
   npm run build:shared
   npm run build:a2a
   npm run build:opencode-compat
   npm run build:server
   npm run worker:build
4. Confirm that the selected ${harness} harness is locally available and already authenticated, without exposing authentication data.
5. Run exactly:
   ${demoCommand}
6. Report the command result, workflow ID, implementation/review endpoint identities, final column, and report.json artifact path. Preserve the demo scratch directory on failure.

If any step fails, stop at that step. Give a concise diagnosis and the minimum human action needed before retrying.`;
}

export function runnerInvocation(runner, mission) {
  return { command: runner, args: ['chat', '-q', mission] };
}

function runnerAvailable(runner) {
  const result = spawnSync(runner, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  return result.status === 0;
}

export function preflight({ repoRoot, runner, printPrompt, environment = process.env }) {
  const errors = [];
  const warnings = [];
  for (const required of ['package.json', 'package-lock.json', 'scripts/demo-board-a2a.mjs']) {
    if (!existsSync(path.join(repoRoot, required))) errors.push(`missing ${required}`);
  }

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 22) warnings.push(`Node ${process.versions.node} is active; the production agent SDK requires Node 22 or newer.`);
  if (environment.NODE_ENV === 'production') warnings.push('NODE_ENV=production omits Vite, Playwright, and tsx; the agent must use npm ci --include=dev.');
  if (!printPrompt && !runnerAvailable(runner)) errors.push(`LLM runner '${runner}' is unavailable. Install/configure it, or use --print-prompt to hand the mission to another local LLM.`);
  return { errors, warnings };
}

function printPreflight(preflightResult) {
  console.log('LLM local-demo handoff preflight');
  for (const warning of preflightResult.warnings) console.log(`warning: ${warning}`);
  for (const error of preflightResult.errors) console.error(`error: ${error}`);
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = preflight({ repoRoot, runner: options.runner, printPrompt: options.printPrompt });
  printPreflight(result);
  if (result.errors.length) {
    process.exitCode = 1;
    return;
  }

  const mission = buildLlmDemoMission({
    repoRoot,
    harness: options.harness,
    boardUrl: options.boardUrl,
  });
  if (options.printPrompt) {
    console.log(`\n--- copy this mission into a local coding LLM ---\n\n${mission}`);
    return;
  }

  const invocation = runnerInvocation(options.runner, mission);
  if (options.dryRun) {
    console.log(`\nWould start: ${invocation.command} ${invocation.args.slice(0, 2).join(' ')} <mission>`);
    return;
  }

  const child = spawn(invocation.command, invocation.args, { cwd: repoRoot, stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`LLM runner exited from ${signal}`));
      else if (code !== 0) reject(new Error(`LLM runner exited with ${code}`));
      else resolve();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
