import { A2A_PROTOCOL_VERSION, type AgentCard, type AgentSkill, type SecurityScheme } from '@a2a-js/sdk';
import type { AgentType, Worker } from '@ai-agent-board/shared/types.js';
import { BOARD_EXTENSION_URI, EXT_WORKER_CONSENT } from './extension.js';

/** Path the A2A router is mounted on; the card advertises it per binding. */
export const BOARD_A2A_BASE_PATH = '/a2a/v1';

export interface NormalizedA2ASkill {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
}

export interface NormalizedA2AAgentCard {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly endpoint: string;
  /** Negotiated `Major.Minor` protocol version; patch versions are dropped. */
  readonly protocolVersion: A2AProtocolVersion;
  readonly skills: readonly NormalizedA2ASkill[];
}

/** A2A protocol versions this board can speak over the JSON-RPC binding. */
export type A2AProtocolVersion = '1.0' | '0.3';

export const SUPPORTED_A2A_PROTOCOL_VERSIONS: readonly A2AProtocolVersion[] = ['1.0', '0.3'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Agent Card ${field} must be a non-empty string`);
  }
  return value.trim();
}

export function isAllowedA2AUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const hostname = url.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function isA2AProtocolVersion(value: unknown): value is A2AProtocolVersion {
  return typeof value === 'string' && (SUPPORTED_A2A_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

/** Only `Major.Minor` participates in protocol version negotiation. */
export function normalizeProtocolVersion(advertised: string): A2AProtocolVersion | undefined {
  const [major, minor = '0'] = advertised.trim().split('.');
  const candidate = `${major}.${minor}`;
  return isA2AProtocolVersion(candidate) ? candidate : undefined;
}

function normalizeSkills(value: unknown): readonly NormalizedA2ASkill[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((skill): readonly NormalizedA2ASkill[] => {
    if (!isRecord(skill) || typeof skill.id !== 'string' || typeof skill.name !== 'string') return [];
    const tags = Array.isArray(skill.tags)
      ? skill.tags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    return [{ id: skill.id, name: skill.name, tags }];
  });
}

/** Validates the Agent Card fields needed for the board's trusted directory. */
export function normalizeA2AAgentCard(value: unknown): NormalizedA2AAgentCard {
  if (!isRecord(value)) throw new Error('Agent Card must be an object');

  const name = requiredString(value.name, 'name');
  const description = requiredString(value.description, 'description');
  const version = requiredString(value.version, 'version');
  const interfaces = Array.isArray(value.supportedInterfaces) ? value.supportedInterfaces : [];

  for (const candidate of interfaces) {
    if (!isRecord(candidate) || candidate.protocolBinding !== 'JSONRPC') continue;
    if (typeof candidate.url !== 'string' || typeof candidate.protocolVersion !== 'string') continue;
    const protocolVersion = normalizeProtocolVersion(candidate.protocolVersion);
    if (protocolVersion === undefined) continue;
    let endpoint: URL;
    try {
      endpoint = new URL(candidate.url);
    } catch {
      continue;
    }
    if (!isAllowedA2AUrl(endpoint)) continue;

    return {
      name,
      description,
      version,
      endpoint: endpoint.toString(),
      protocolVersion,
      skills: normalizeSkills(value.skills),
    };
  }

  throw new Error('Agent Card does not provide a usable JSON-RPC HTTPS interface');
}

export interface BoardCardOptions {
  /** Public origin of the board, e.g. `https://kanban.example.com`. */
  readonly baseUrl: string;
  /** Board version, surfaced to peers for compatibility decisions. */
  readonly version: string;
  /** When true, the card declares bearer auth (set whenever API_KEY/SERVICE_TOKENS are configured). */
  readonly authRequired: boolean;
  readonly documentationUrl?: string;
}

function bearerScheme(): SecurityScheme {
  return {
    scheme: {
      $case: 'httpAuthSecurityScheme',
      value: {
        description: 'Board API key or a service token scoped to a2a:send.',
        scheme: 'Bearer',
        bearerFormat: 'opaque',
      },
    },
  };
}

function skill(
  id: string,
  name: string,
  description: string,
  tags: readonly string[],
  examples: readonly string[],
): AgentSkill {
  return {
    id,
    name,
    description,
    tags: [...tags],
    examples: [...examples],
    inputModes: [],
    outputModes: [],
    securityRequirements: [],
  };
}

/**
 * The board's Agent Card: what another agent or an orchestrator can ask this
 * board to do. See `docs/specs/a2a-protocol-adoption.md` §4.5.
 */
export function boardAgentCard(options: BoardCardOptions): AgentCard {
  const origin = options.baseUrl.replace(/\/$/, '');
  const securitySchemes: Record<string, SecurityScheme> = options.authRequired ? { bearer: bearerScheme() } : {};
  return {
    name: 'Infinite Kanban Board',
    description:
      'An agentic Kanban board. Accepts delegated coding work, tracks it as a task through backlog → in progress → review → done, '
      + 'streams agent progress, asks for input when an agent is blocked, and returns the result as an artifact.',
    supportedInterfaces: [
      {
        url: `${origin}${BOARD_A2A_BASE_PATH}`,
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
      {
        url: `${origin}${BOARD_A2A_BASE_PATH}`,
        protocolBinding: 'HTTP+JSON',
        tenant: '',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: { organization: 'Infinite Kanban', url: origin },
    version: options.version,
    documentationUrl: options.documentationUrl,
    capabilities: {
      streaming: true,
      pushNotifications: true,
      extendedAgentCard: true,
      extensions: [
        {
          uri: BOARD_EXTENSION_URI,
          description: 'Board task metadata: agent event envelopes, task assignments, worker consent.',
          required: false,
          params: undefined,
        },
      ],
    },
    securitySchemes,
    securityRequirements: options.authRequired ? [{ schemes: { bearer: { list: [] } } }] : [],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      skill(
        'code-task',
        'Implement a coding task',
        'Implement a change in one of the board\'s projects. The board resolves the repository, isolates the run in a git worktree, '
        + 'runs a coding agent, and reports progress and the resulting branch.',
        ['code', 'implement', 'git', 'kanban'],
        ['Add rate limiting to the worker event endpoint in project "board"'],
      ),
      skill(
        'code-review',
        'Review an existing implementation',
        'Validate an existing implementation on its branch and report a verdict (pass or changes requested) instead of re-implementing it.',
        ['code', 'review', 'verdict'],
        ['Review the implementation on branch agent/rate-limit-worker-events'],
      ),
      skill(
        'task-group',
        'Run a group of related tasks',
        'Run 2–20 related child tasks with bounded parallelism, advancing to review when every child completes.',
        ['code', 'batch', 'parallel'],
        ['Split this refactor into 5 tasks and run 2 at a time'],
      ),
    ],
    signatures: [],
    iconUrl: undefined,
  };
}

export interface WorkerCardOptions {
  readonly baseUrl: string;
  readonly version: string;
  readonly name: string;
  readonly agentTypes: readonly AgentType[];
  readonly authRequired: boolean;
  readonly consent?: Pick<Worker, 'acceptedProjectIds' | 'acceptedLabels'>;
}

/**
 * A worker's Agent Card. Workers are A2A servers the board dials (spec §5,
 * option A): their skills are the agent types they can run, and their consent
 * (which projects and labels they will accept) rides in the board extension
 * so it stays worker-owned and explicit.
 */
export function workerAgentCard(options: WorkerCardOptions): AgentCard {
  const origin = options.baseUrl.replace(/\/$/, '');
  const consent = options.consent ?? {};
  return {
    name: options.name,
    description: `Infinite Kanban worker running ${options.agentTypes.join(', ') || 'no'} agent(s) in its local workspace.`,
    supportedInterfaces: [
      {
        url: `${origin}${BOARD_A2A_BASE_PATH}`,
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: { organization: 'Infinite Kanban', url: origin },
    version: options.version,
    documentationUrl: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        {
          uri: BOARD_EXTENSION_URI,
          description: 'Board task assignments and worker consent.',
          required: false,
          params: { [EXT_WORKER_CONSENT]: consent },
        },
      ],
    },
    securitySchemes: options.authRequired ? { bearer: bearerScheme() } : {},
    securityRequirements: options.authRequired ? [{ schemes: { bearer: { list: [] } } }] : [],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: options.agentTypes.map((agentType) => skill(
      `run-${agentType}`,
      `Run a task with ${agentType}`,
      `Execute a board task in this worker's workspace using the ${agentType} agent.`,
      ['code', agentType],
      [],
    )),
    signatures: [],
    iconUrl: undefined,
  };
}
