import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';
import type { WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import {
  isValidAgentType,
  VALID_AGENT_TYPES,
  WORKER_ASSIGNMENT_POLL_INTERVAL_MS,
  WORKER_HEARTBEAT_INTERVAL_MS,
} from '@ai-agent-board/shared/constants.js';
import { claimTask, completeTaskFailure, fetchAssignments, request, requestWithLoggedFailure, sendEvent, type Config } from './api.js';
import {
  parseWorkspaceSettings,
  runOpenCodeTask,
  type RunnerProfile,
} from './local-runner.js';
import { runAgentSdkTask } from './sdk-runner.js';

type Args = Readonly<Record<string, string>>;
const configPath = path.join(os.homedir(), '.agentboard-worker', 'config.json');
const workspaceConfigPath = path.join(os.homedir(), '.agentboard-worker', 'workspace.json');

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

async function saveWorkspaceConfig(workspacePath: string): Promise<void> {
  await fs.mkdir(path.dirname(workspaceConfigPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(workspaceConfigPath, `${JSON.stringify({ workspacePath }, null, 2)}\n`, { mode: 0o600 });
}

async function loadConfig(): Promise<Config> {
  return JSON.parse(await fs.readFile(configPath, 'utf8')) as Config;
}

function safeWorkerError(error: unknown, workspacePath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(workspacePath, '[local workspace]');
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

async function register(args: Args): Promise<void> {
  const serverUrl = await prompt('server URL', args.serverUrl);
  const token = await prompt('registration token', args.token);
  const name = await prompt('worker name', args.name || os.hostname());
  const workspacePath = await prompt('local workspace path', args.workspacePath);
  const workspaceStats = await fs.stat(workspacePath).catch(() => undefined);
  if (!workspaceStats?.isDirectory()) {
    throw new Error('worker workspace configuration must point to a directory');
  }
  const rawTypes = await prompt('agent types (comma separated)', args.agentTypes || VALID_AGENT_TYPES.join(','));
  const agentTypes = rawTypes.split(',').map((value) => value.trim()).filter(isValidAgentType);
  if (agentTypes.length === 0) {
    throw new Error('agent-types must include at least one supported provider');
  }
  const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/workers/register`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name, agentTypes, hostname: os.hostname(), version: '0.1.0' }),
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
  await saveWorkspaceConfig(workspacePath);
  console.log(`registered worker ${responseBody.worker.id}; credentials saved to ${configPath}`);
}


function assertNever(value: never): never {
  throw new Error(`unsupported runner kind: ${String(value)}`);
}

async function executeTask(
  config: Config,
  task: WorkerTaskAssignment,
  claimToken: string,
  workspacePath: string,
  runner: RunnerProfile,
  abortSignal: AbortSignal,
): Promise<void> {
  const sendTaskEvent = async (event: Parameters<typeof sendEvent>[3]): Promise<void> => {
    await sendEvent(config, task, claimToken, event);
  };

  const result = await (() => {
    switch (runner.kind) {
      case 'agent-sdk':
        return runAgentSdkTask({
          task,
          workingDirectory: workspacePath,
          sendEvent: sendTaskEvent,
        });
      case 'opencode-run':
        return runOpenCodeTask({
          task,
          workspacePath,
          runner,
          sendEvent: sendTaskEvent,
          abortSignal,
        });
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
    }),
  });
}

async function run(): Promise<void> {
  const config = await loadConfig();
  const workspaceSettings = await loadWorkspaceSettings();
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
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === 'register') {
    await register(args);
  } else if (command === 'run') {
    await run();
  } else {
    throw new Error('usage: agentboard-worker register|run [options]');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((error: unknown) => {
    console.error(`[worker] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
