import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { v4 as uuid } from 'uuid';
import { ClaudeProvider, CodexProvider, CopilotProvider, GrokProvider, HermesProvider, OpenClawProvider, OpenCodeProvider, type AgentProvider, type AgentEvent as CoreEvent } from '@codewithdan/agent-sdk-core';
import type { AgentEvent, AgentType, WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import { isValidAgentType, VALID_AGENT_TYPES, WORKER_ASSIGNMENT_POLL_INTERVAL_MS, WORKER_HEARTBEAT_INTERVAL_MS } from '@ai-agent-board/shared/constants.js';

type Config = { readonly workerId: string; readonly workerToken: string; readonly serverUrl: string };
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

async function loadWorkspacePath(): Promise<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(workspaceConfigPath, 'utf8')) as unknown;
  } catch {
    throw new Error('worker workspace configuration is missing or invalid');
  }
  if (
    !raw
    || typeof raw !== 'object'
    || Object.keys(raw).length !== 1
    || !('workspacePath' in raw)
    || typeof raw.workspacePath !== 'string'
  ) {
    throw new Error('worker workspace configuration is invalid');
  }
  const workspacePath = raw.workspacePath;
  const stats = await fs.stat(workspacePath).catch(() => undefined);
  if (!stats?.isDirectory()) {
    throw new Error('worker workspace configuration must point to a directory');
  }
  return workspacePath;
}

function safeWorkerError(error: unknown, workspacePath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(workspacePath, '[local workspace]');
}

function urlFor(serverUrl: string, endpoint: string): string {
  return `${serverUrl.replace(/\/$/, '')}/api/workers${endpoint}`;
}

async function request<T>(config: Config, endpoint: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(urlFor(config.serverUrl, endpoint), {
    ...init,
    headers: {
      authorization: `Bearer ${config.workerToken}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`worker API ${response.status}: ${JSON.stringify(body)}`);
  return body as T;
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

function providerFor(agentType: AgentType): AgentProvider {
  switch (agentType) {
    case 'copilot':
      return new CopilotProvider();
    case 'claude':
      return new ClaudeProvider();
    case 'codex':
      return new CodexProvider();
    case 'opencode':
      return new OpenCodeProvider();
    case 'hermes':
      return new HermesProvider();
    case 'openclaw':
      return new OpenClawProvider();
    case 'grok':
      return new GrokProvider();
    default:
      throw new Error(`unsupported agent type: ${agentType satisfies never}`);
  }
}

async function sendEvent(config: Config, task: WorkerTaskAssignment, claimToken: string, event: AgentEvent): Promise<void> {
  await request(config, `/me/tasks/${task.id}/events`, {
    method: 'POST',
    headers: { 'x-worker-claim': claimToken },
    body: JSON.stringify(event),
  });
}

async function executeTask(config: Config, task: WorkerTaskAssignment, claimToken: string, workingDirectory: string): Promise<void> {
  const agentType = task.agentType;
  if (!agentType || !isValidAgentType(agentType)) {
    throw new Error('task has no supported agentType');
  }
  const provider = providerFor(agentType);
  await provider.start();
  const session = await provider.createSession({
    contextId: task.id,
    workingDirectory,
    systemPrompt: 'Work in the locally configured workspace. Follow the workspace instructions and skills. '
      + `Task title: ${task.title}`,
    onEvent: (event: CoreEvent) => {
      const mapped: AgentEvent = {
        id: event.id || uuid(),
        taskId: task.id,
        type: event.type as AgentEvent['type'],
        content: event.content,
        timestamp: event.timestamp,
        ...(event.metadata ? { metadata: event.metadata as AgentEvent['metadata'] } : {}),
      };
      void sendEvent(config, task, claimToken, mapped).catch((error: unknown) => {
        console.error(`[worker] event upload failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });
  try {
    const result = await session.execute(`${task.title}\n\n${task.description}`);
    await request(config, `/me/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { 'x-worker-claim': claimToken },
      body: JSON.stringify({ status: result.status, error: result.error ? safeWorkerError(result.error, workingDirectory) : result.error }),
    });
  } finally {
    await session.destroy();
    await provider.stop();
  }
}

async function run(): Promise<void> {
  const config = await loadConfig();
  const workspacePath = await loadWorkspacePath();
  let stopping = false;
  let current: { task: WorkerTaskAssignment; claimToken: string } | undefined;
  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const heartbeat = setInterval(() => {
    const heartbeatBody = current ? { currentTaskId: current.task.id } : {};
    const heartbeatHeaders: Record<string, string> = current
      ? { 'x-worker-claim': current.claimToken }
      : {};
    void request(config, '/me/heartbeat', {
      method: 'POST',
      headers: heartbeatHeaders,
      body: JSON.stringify(heartbeatBody),
    }).catch((error: unknown) => {
      console.error(`[worker] heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, WORKER_HEARTBEAT_INTERVAL_MS);
  try {
    while (!stopping) {
      if (!current) {
        const response = await request<{ tasks: readonly WorkerTaskAssignment[] }>(config, '/me/assignments');
        const task = response.tasks[0];
        if (task) {
          try {
            const claimed = await request<{ task: WorkerTaskAssignment; claimToken: string }>(config, `/me/tasks/${task.id}/claim`, { method: 'POST' });
            current = { task: claimed.task, claimToken: claimed.claimToken };
            await executeTask(config, claimed.task, claimed.claimToken, workspacePath);
          } catch (error: unknown) {
            const message = safeWorkerError(error, workspacePath);
            if (current) {
              await request(config, `/me/tasks/${current.task.id}/complete`, {
                method: 'POST',
                headers: { 'x-worker-claim': current.claimToken },
                body: JSON.stringify({ status: 'failed', error: message }),
              }).catch(() => undefined);
            }
            console.error(`[worker] task failed: ${message}`);
          } finally {
            current = undefined;
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

main().catch((error: unknown) => {
  console.error(`[worker] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
