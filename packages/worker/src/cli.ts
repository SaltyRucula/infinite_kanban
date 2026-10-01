#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';
import type { WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import {
  isValidAgentType,
  MAX_DESCRIPTION_LENGTH,
  VALID_AGENT_TYPES,
  WORKER_ASSIGNMENT_POLL_INTERVAL_MS,
  WORKER_HEARTBEAT_INTERVAL_MS,
} from '@ai-agent-board/shared/constants.js';
import {
  claimTask,
  completeTaskFailure,
  fetchAssignments,
  pollTaskCommands,
  registerTaskSession,
  request,
  requestWithLoggedFailure,
  sendEvent,
  type Config,
} from './api.js';
import {
  parseWorkspaceSettings,
  startOpenCodeServerTask,
  type OpenCodeRunResult,
  type RunnerProfile,
} from './local-runner.js';
import { OpenCodeSessionBridge } from './opencode-session-bridge.js';
import { startAgentSdkTask, type SdkRunResult } from './sdk-runner.js';

export type CommandArgs = Readonly<Record<string, string>>;
type Args = CommandArgs;
const configPath = path.join(os.homedir(), '.agentboard-worker', 'config.json');
const workspaceConfigPath = path.join(os.homedir(), '.agentboard-worker', 'workspace.json');
const execFile = promisify(execFileCallback);

export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type StartPreflightOptions = {
  readonly nodeVersion?: string;
  readonly runCommand?: (command: string, args: readonly string[]) => Promise<CommandResult>;
};

async function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  const result = await execFile(command, [...args], { windowsHide: true });
  return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
}

function hasAuthenticatedOpenCodeProvider(output: string): boolean {
  try {
    const parsed: unknown = JSON.parse(output) as unknown;
    if (Array.isArray(parsed)) return parsed.length > 0;
    return parsed !== null && typeof parsed === 'object' && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

export async function runStartPreflight(options: StartPreflightOptions = {}): Promise<void> {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    throw new Error(`Node.js 22 or newer is required to start a worker (found ${nodeVersion}). Install Node 22+ and retry.`);
  }

  const command = options.runCommand ?? runCommand;
  let version: CommandResult;
  try {
    version = await command('opencode', ['--version']);
  } catch {
    throw new Error('OpenCode CLI is required to start a worker. Install it with `npm install --global @opencode/cli`, then retry.');
  }
  if (version.exitCode !== 0) {
    throw new Error('OpenCode CLI is required to start a worker. Install it with `npm install --global @opencode/cli`, then retry.');
  }

  let auth: CommandResult;
  try {
    auth = await command('opencode', ['auth', 'list', '--format', 'json']);
  } catch {
    throw new Error('OpenCode is not authenticated. Run `opencode auth login` and retry.');
  }
  if (auth.exitCode !== 0 || !hasAuthenticatedOpenCodeProvider(auth.stdout)) {
    throw new Error('OpenCode is not authenticated. Run `opencode auth login` and retry.');
  }
}

function parseArgs(values: readonly string[]): Args {
  const result: Record<string, string> = {};
  for (let i = 0; i < values.length; i += 1) {
    const key = values[i];
    if (key?.startsWith('--')) {
      const value = values[i + 1];
      if (value && !value.startsWith('--')) {
        result[key.slice(2)] = value;
        i += 1;
      }
    }
  }
  return result;
}

async function prompt(name: string, supplied: string | undefined): Promise<string> {
  if (supplied) return supplied;
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(`${name}: `)).trim();
  } finally {
    rl.close();
  }
}

async function saveConfig(config: Config): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// Issue #25: register/start must write a complete `runner` block into
// workspace.json so neither runner profile needs a hand-edit. This resolver
// turns the optional --runner/--agent flags into a concrete RunnerProfile,
// defaulting to the agent-sdk runner when no flags are supplied.
export function resolveRunnerProfile(
  runnerKind: string | undefined,
  agent: string | undefined,
): RunnerProfile {
  const kind = (runnerKind ?? '').trim() || 'agent-sdk';
  if (kind === 'agent-sdk') {
    return { kind: 'agent-sdk' };
  }
  if (kind === 'opencode-server') {
    const resolvedAgent = (agent ?? '').trim() || 'build';
    return { kind: 'opencode-server', agent: resolvedAgent };
  }
  throw new Error('runner must be either "agent-sdk" or "opencode-server"');
}

// Issue #25: build the full workspace.json payload including the runner block,
// so a registered worker never needs a manual JSON edit to use either profile.
export function buildWorkspaceConfig(
  workspacePath: string,
  runner: RunnerProfile,
): { readonly workspacePath: string; readonly runner: RunnerProfile } {
  return { workspacePath, runner };
}

export type EnrollmentCode = {
  readonly serverUrl: string;
  readonly enrollmentCode: string;
};

// Enrollment links intentionally use the fragment: browsers do not send it to
// the board when the Add worker UI renders a copy-paste command, while the
// worker can still recover the board origin and one-time credential locally.
export function parseEnrollmentCode(value: string): EnrollmentCode {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('start code must be a valid enrollment URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.pathname !== '/api/workers/enroll'
    || url.search
    || !url.hash.slice(1)) {
    throw new Error('start code must be an enrollment URL with a one-time code fragment');
  }
  return { serverUrl: url.origin, enrollmentCode: decodeURIComponent(url.hash.slice(1)) };
}

async function saveWorkspaceConfig(workspacePath: string, runner: RunnerProfile): Promise<void> {
  await fs.mkdir(path.dirname(workspaceConfigPath), { recursive: true, mode: 0o700 });
  const config = buildWorkspaceConfig(workspacePath, runner);
  await fs.writeFile(workspaceConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

async function loadConfig(): Promise<Config> {
  return JSON.parse(await fs.readFile(configPath, 'utf8')) as Config;
}

function safeWorkerError(error: unknown, workspacePath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(workspacePath, '[local workspace]');
}

// The server rejects an `awaiting_input` completion whose question exceeds
// MAX_DESCRIPTION_LENGTH with a 400, which the worker's catch-all then turns
// into a `failed` task — losing the question AND the work summary. Truncate
// here, worker-side, before POSTing so a runaway extraction (see
// extractInputRequest) can never trigger that failure path.
export function truncateQuestion(question: string): string {
  if (question.length <= MAX_DESCRIPTION_LENGTH) return question;
  // .slice() truncates by UTF-16 code unit and can split a surrogate pair
  // (e.g. an emoji), leaving a lone surrogate that renders as a replacement
  // character. Iterate by Unicode code point instead (the string iterator is
  // surrogate-pair aware) so truncation always lands on a whole character
  // boundary, while still keeping the result within MAX_DESCRIPTION_LENGTH
  // UTF-16 units — the same unit the server's length check uses.
  let result = '';
  for (const char of question) {
    if (result.length + char.length > MAX_DESCRIPTION_LENGTH) break;
    result += char;
  }
  return result;
}

async function loadWorkspaceSettings(): Promise<{ readonly workspacePath: string; readonly runner: RunnerProfile }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(workspaceConfigPath, 'utf8')) as unknown;
  } catch {
    throw new Error('worker workspace configuration is missing or invalid');
  }
  const parsed = parseWorkspaceSettings(raw);
  const stats = await fs.stat(parsed.workspacePath).catch(() => undefined);
  if (!stats?.isDirectory()) {
    throw new Error('worker workspace configuration must point to a directory');
  }
  return parsed;
}

async function register(args: Args, enrollmentCode?: string): Promise<void> {
  const serverUrl = await prompt('server URL', args.serverUrl);
  const token = enrollmentCode ? undefined : await prompt('registration token', args.token);
  const name = await prompt('worker name', args.name || os.hostname());
  const workspacePath = await prompt('local workspace path', args.workspacePath || process.cwd());
  const workspaceStats = await fs.stat(workspacePath).catch(() => undefined);
  if (!workspaceStats?.isDirectory()) {
    throw new Error('worker workspace configuration must point to a directory');
  }
  const rawTypes = await prompt('agent types (comma separated)', args.agentTypes || VALID_AGENT_TYPES.join(','));
  const agentTypes = rawTypes.split(',').map((value) => value.trim()).filter(isValidAgentType);
  if (agentTypes.length === 0) {
    throw new Error('agent-types must include at least one supported provider');
  }
  // Issue #25: resolve the runner from optional --runner/--agent flags (defaults
  // to the agent-sdk profile) and persist it, so no manual workspace.json edit
  // is required for either runner profile.
  const runner = resolveRunnerProfile(args.runner, args.agent);
  const acceptedProjectIds = (args['accepted-project-ids'] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const acceptedLabels = (args['accepted-labels'] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/workers/register`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name,
      agentTypes,
      acceptedProjectIds,
      acceptedLabels,
      hostname: os.hostname(),
      version: '0.1.0',
      ...(enrollmentCode ? { enrollmentCode } : {}),
    }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`registration failed (${response.status}): ${JSON.stringify(body)}`);
  }
  if (!body || typeof body !== 'object' || !('worker' in body) || !('token' in body)) {
    throw new Error('registration response was invalid');
  }
  const responseBody = body as { worker: { id: string }; token: string };
  await saveConfig({ workerId: responseBody.worker.id, workerToken: responseBody.token, serverUrl });
  await saveWorkspaceConfig(workspacePath, runner);
  console.log(`registered worker ${responseBody.worker.id}; credentials saved to ${configPath}`);
}


function assertNever(value: never): never {
  throw new Error(`unsupported runner kind: ${String(value)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CommandAwareTaskRun = {
  readonly done: Promise<SdkRunResult | OpenCodeRunResult>;
  sendMessage(message: string, attachmentIds?: readonly string[]): Promise<void>;
  abort(): Promise<void>;
};

function parseBridgePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error('OPENCODE_SESSION_BRIDGE_PORT must be an integer between 0 and 65535');
  }
  return parsed;
}

async function runCommandLoop(
  config: Config,
  taskId: string,
  claimToken: string,
  run: CommandAwareTaskRun,
  workspacePath: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const commands = await pollTaskCommands(config, taskId, claimToken);
    if (commands) {
      for (const command of commands) {
        if (command.type === 'cancel') {
          await run.abort().catch((error: unknown) => {
            console.error(`[worker] cancel command failed: ${safeWorkerError(error, workspacePath)}`);
          });
          continue;
        }
        if (command.type === 'message') {
          const message = typeof command.message === 'string' ? command.message.trim() : '';
          if (!message) continue;
          await run.sendMessage(message, command.attachmentIds).catch((error: unknown) => {
            console.error(`[worker] follow-up command failed: ${safeWorkerError(error, workspacePath)}`);
          });
          continue;
        }
        const answer = typeof command.answer === 'string' ? command.answer.trim() : '';
        if (!answer) continue;
        await run.sendMessage(answer).catch((error: unknown) => {
          console.error(`[worker] clarification command failed: ${safeWorkerError(error, workspacePath)}`);
        });
      }
    }
    await sleep(750);
  }
}

async function executeTask(
  config: Config,
  task: WorkerTaskAssignment,
  claimToken: string,
  workspacePath: string,
  runner: RunnerProfile,
  sessionBridge: OpenCodeSessionBridge,
  abortSignal: AbortSignal,
): Promise<void> {
  const sendTaskEvent = async (event: Parameters<typeof sendEvent>[3]): Promise<void> => {
    await sendEvent(config, task, claimToken, event);
  };

  const runLiveTask = async (run: CommandAwareTaskRun): Promise<SdkRunResult | OpenCodeRunResult> => {
    const control = new AbortController();
    const onAbort = (): void => {
      control.abort();
      void run.abort();
    };
    if (abortSignal.aborted) onAbort();
    abortSignal.addEventListener('abort', onAbort, { once: true });
    try {
      const loop = runCommandLoop(config, task.id, claimToken, run, workspacePath, control.signal);
      const done = await run.done;
      control.abort();
      await loop;
      return done;
    } finally {
      abortSignal.removeEventListener('abort', onAbort);
      control.abort();
    }
  };

  let sessionId: string | undefined;
  try {
    const result = await (async (): Promise<SdkRunResult | OpenCodeRunResult> => {
      switch (runner.kind) {
        case 'agent-sdk': {
          const live = await startAgentSdkTask({
            task,
            workingDirectory: workspacePath,
            sendEvent: sendTaskEvent,
          });
          sessionId = live.sessionId ?? undefined;
          if (live.sessionId && live.baseUrl) {
            const bridgeUrl = sessionBridge.register({
              taskId: task.id,
              sessionId: live.sessionId,
              workspacePath,
              baseUrl: live.baseUrl,
            });
            await registerTaskSession(config, task.id, claimToken, live.sessionId, bridgeUrl);
          }
          return runLiveTask({
            done: live.done,
            sendMessage: (message, attachmentIds) => live.sendMessage(message, attachmentIds),
            abort: () => live.abort(),
          });
        }
        case 'opencode-server': {
          const live = await startOpenCodeServerTask({
            task,
            workspacePath,
            runner,
            sendEvent: sendTaskEvent,
          });
          sessionId = live.sessionId;
          const bridgeUrl = sessionBridge.register({
            taskId: task.id,
            sessionId: live.sessionId,
            workspacePath,
            baseUrl: live.baseUrl,
          });
          await registerTaskSession(config, task.id, claimToken, live.sessionId, bridgeUrl);
          return runLiveTask({
            done: live.done,
            sendMessage: (message) => live.sendMessage(message),
            abort: () => live.abort(),
          });
        }
        default:
          return assertNever(runner);
      }
    })();

    await request(config, `/me/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { 'x-worker-claim': claimToken },
      body: JSON.stringify({
        status: result.status,
        ...(result.summary ? { summary: safeWorkerError(result.summary, workspacePath) } : {}),
        ...(result.error ? { error: safeWorkerError(result.error, workspacePath) } : {}),
        ...(result.question ? { question: truncateQuestion(safeWorkerError(result.question, workspacePath)) } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(result.reviewVerdict ? { reviewVerdict: result.reviewVerdict } : {}),
      }),
    });
  } finally {
    sessionBridge.unregister(task.id);
  }
}

async function run(): Promise<void> {
  const config = await loadConfig();
  const workspaceSettings = await loadWorkspaceSettings();
  const sessionBridge = await OpenCodeSessionBridge.start({
    port: parseBridgePort(process.env.OPENCODE_SESSION_BRIDGE_PORT),
  });
  let stopping = false;
  let current: { task: WorkerTaskAssignment; claimToken: string } | undefined;
  let currentAbortController: AbortController | undefined;
  const stop = (): void => {
    stopping = true;
    currentAbortController?.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const heartbeat = setInterval(() => {
    const heartbeatBody = current ? { currentTaskId: current.task.id } : {};
    const heartbeatHeaders: Record<string, string> = current
      ? { 'x-worker-claim': current.claimToken }
      : {};
    void requestWithLoggedFailure('heartbeat', () => request(config, '/me/heartbeat', {
      method: 'POST',
      headers: heartbeatHeaders,
      body: JSON.stringify(heartbeatBody),
    }));
  }, WORKER_HEARTBEAT_INTERVAL_MS);
  try {
    while (!stopping) {
      if (!current) {
        const tasks = await fetchAssignments(config);
        if (!tasks) {
          await new Promise((resolve) => setTimeout(resolve, WORKER_ASSIGNMENT_POLL_INTERVAL_MS));
          continue;
        }
        const task = tasks[0];
        if (task) {
          const claimed = await claimTask(config, task.id);
          if (!claimed) {
            await new Promise((resolve) => setTimeout(resolve, WORKER_ASSIGNMENT_POLL_INTERVAL_MS));
            continue;
          }
          current = { task: claimed.task, claimToken: claimed.claimToken };
          currentAbortController = new AbortController();
          try {
            await executeTask(
              config,
              claimed.task,
              claimed.claimToken,
              workspaceSettings.workspacePath,
              workspaceSettings.runner,
              sessionBridge,
              currentAbortController.signal,
            );
          } catch (error: unknown) {
            const message = safeWorkerError(error, workspaceSettings.workspacePath);
            if (current) {
              await completeTaskFailure(config, current.task.id, current.claimToken, message);
            }
            console.error(`[worker] task failed: ${message}`);
          } finally {
            current = undefined;
            currentAbortController = undefined;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, WORKER_ASSIGNMENT_POLL_INTERVAL_MS));
    }
  } finally {
    clearInterval(heartbeat);
    await sessionBridge.close();
  }
}

export type CommandHandlers = {
  preflight?(): Promise<void>;
  register(args: CommandArgs, enrollmentCode?: string): Promise<void>;
  run(): Promise<void>;
};

export async function dispatchCommand(
  command: string | undefined,
  args: CommandArgs,
  handlers: CommandHandlers = { preflight: runStartPreflight, register, run },
): Promise<void> {
  if (command === 'start') {
    await handlers.preflight?.();
    const code = parseEnrollmentCode(args.code ?? '');
    await handlers.register({ ...args, serverUrl: code.serverUrl }, code.enrollmentCode);
    await handlers.run();
  } else if (command === 'register') {
    await handlers.register(args);
  } else if (command === 'run') {
    await handlers.run();
  } else {
    throw new Error('usage: agentboard-worker start --code <enrollment-url> | register|run [options]');
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  await dispatchCommand(command, parseArgs(rest));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((error: unknown) => {
    console.error(`[worker] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
