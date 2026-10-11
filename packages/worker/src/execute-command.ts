import path from 'node:path';
import os from 'node:os';
import { startExecutionEndpoint } from './execution-endpoint.js';
import type { ExecutionEndpointConfig } from './execution-adapter.js';

export type ExecuteArgs = Readonly<Record<string, string>>;

const ROLES = ['implementation', 'review'] as const;
const HARNESSES = ['opencode', 'codex'] as const;

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Turn CLI flags into an endpoint configuration.
 *
 * Everything here is endpoint-local on purpose: the harness, the model and the
 * checkout paths are this process's business, and never travel to the board or
 * appear in a task. The board only learns the role, the repository identity and
 * the projects this endpoint consents to.
 */
export function executionEndpointConfig(args: ExecuteArgs): ExecutionEndpointConfig {
  // An endpoint is not an implementer or a reviewer by nature; it is whatever
  // roles it is configured to accept. The board keeps the two apart per task by
  // refusing to let the endpoint that produced a revision review it, so one
  // endpoint holding both roles is normal: it implements some tasks and reviews
  // others.
  const roles = list(args.role);
  if (!roles.length) throw new Error('--role is required (implementation, review, or both)');
  for (const role of roles) {
    if (!ROLES.includes(role as (typeof ROLES)[number])) {
      throw new Error(`--role must be one of ${ROLES.join(', ')}`);
    }
  }
  if (new Set(roles).size !== roles.length) throw new Error('--role may name each role only once');
  // Keep a stable order so the default identity directory and the advertised
  // card do not depend on the order the flags happened to be typed in.
  const orderedRoles = ROLES.filter((role) => roles.includes(role));

  const harness = (args.harness ?? 'opencode').trim();
  if (!HARNESSES.includes(harness as (typeof HARNESSES)[number])) {
    throw new Error(`--harness must be one of ${HARNESSES.join(', ')}`);
  }

  const projects = list(args.project);
  if (!projects.length) throw new Error('--project is required; an endpoint must consent to the projects it serves');

  const repositories: Record<string, string> = {};
  const repoEntries = list(args.repo);
  if (!repoEntries.length) throw new Error('--repo is required (portable identity=/local/path)');
  for (const entry of repoEntries) {
    // The identity is what the board puts on the wire; the path is where this
    // machine happens to keep that repository. One cannot be guessed from the other.
    const separator = entry.indexOf('=');
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`--repo must be identity=/local/path, got "${entry}"`);
    }
    repositories[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }

  const checks = list(args.check).map((entry) => {
    const separator = entry.indexOf('=');
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`--check must be name=command with optional arguments, got "${entry}"`);
    }
    const [command, ...commandArgs] = entry.slice(separator + 1).trim().split(/\s+/);
    return { name: entry.slice(0, separator).trim(), command, args: commandArgs };
  });

  return {
    harness: harness as (typeof HARNESSES)[number],
    ...(args.model?.trim() ? { model: args.model.trim() } : {}),
    roles: [...orderedRoles],
    projects,
    repositories,
    stateDirectory: args['state-dir']?.trim()
      || path.join(os.homedir(), `.agentboard-endpoint-${orderedRoles.join('-')}`),
    capabilities: list(args.capability).length ? list(args.capability) : ['git:revision'],
    checks,
  };
}

export interface ExecutionConnection {
  readonly baseUrl: string;
  readonly agentId: string;
  close(): Promise<void>;
}

async function boardRequest(board: string, route: string, method: string, body: unknown, apiKey?: string): Promise<unknown> {
  const response = await fetch(new URL(route, board), {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

/**
 * Start the endpoint, then tell the board where to fetch its Agent Card and ask
 * for the role. Registration failures must surface: an endpoint that is running
 * but unknown to the board looks healthy while silently receiving no work.
 */
export async function connectExecutionEndpoint(args: ExecuteArgs): Promise<ExecutionConnection> {
  const config = executionEndpointConfig(args);
  const board = (args.board ?? 'http://127.0.0.1:8080').trim();
  const apiKey = args['api-key']?.trim() || process.env.AGENT_BOARD_API_KEY?.trim();

  const endpoint = await startExecutionEndpoint(config, { port: Number(args.port ?? 0) });
  try {
    const registration = await boardRequest(board, '/api/a2a-agents', 'POST', {
      agentCardUrl: `${endpoint.baseUrl}/.well-known/agent-card.json`,
    }, apiKey) as { id?: string };
    const agentId = registration?.id;
    if (!agentId) throw new Error('the board did not return an agent id for this endpoint');

    for (const projectId of config.projects) {
      await boardRequest(board, `/api/a2a-agents/${agentId}/projects/${projectId}/roles`, 'PUT', {
        roles: config.roles,
      }, apiKey);
    }
    return { baseUrl: endpoint.baseUrl, agentId, close: () => endpoint.close() };
  } catch (error) {
    await endpoint.close().catch(() => undefined);
    throw error;
  }
}

/** `agentboard-worker execute` — run until interrupted. */
export async function executeCommand(args: ExecuteArgs): Promise<void> {
  const connection = await connectExecutionEndpoint(args);
  const config = executionEndpointConfig(args);
  console.log(`execution endpoint listening at ${connection.baseUrl}`);
  console.log(`  registered with the board as agent ${connection.agentId}`);
  console.log(`  roles ${config.roles.join(', ')} · harness ${config.harness}${config.model ? ` · model ${config.model}` : ''}`);
  console.log(`  projects ${config.projects.join(', ')}`);
  for (const [identity, local] of Object.entries(config.repositories)) console.log(`  repository ${identity} -> ${local}`);
  console.log('  waiting for the board to assign work; Ctrl-C to stop');

  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await connection.close();
}
