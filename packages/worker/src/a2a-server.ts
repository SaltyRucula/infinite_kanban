import express, { type Router } from 'express';
import { Role, TaskState, type AgentCard, type Message, type Task } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type { AgentType, WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';

const A2A_BASE_PATH = '/a2a/v1';
const AGENT_CARD_PATH = '/.well-known/agent-card.json';
const ASSIGNMENT_EXTENSION = 'https://github.com/SaltyRucula/infinite_kanban/a2a/board/v1#assignment';
const ASSIGNMENT_KEYS = new Set([
  'id', 'title', 'description', 'priority', 'agentType', 'branchName', 'baseBranch',
  'useWorktree', 'timeoutMinutes', 'labels', 'project', 'agentPreference', 'resume', 'mode',
]);

export interface WorkerA2ARouterOptions {
  readonly baseUrl: string;
  readonly name: string;
  readonly version: string;
  readonly agentTypes: readonly AgentType[];
  readonly dispatch: (assignment: WorkerTaskAssignment) => Promise<void>;
  readonly cancel?: (taskId: string) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assignmentFromMessage(message: Message): WorkerTaskAssignment {
  const candidate = message.metadata?.[ASSIGNMENT_EXTENSION]
    ?? message.parts.find((part) => part.content?.$case === 'data')?.content?.value;
  if (!isRecord(candidate)) throw new RequestMalformedError('no board assignment payload found in message');
  const unknown = Object.keys(candidate).filter((key) => !ASSIGNMENT_KEYS.has(key));
  if (unknown.length > 0) throw new RequestMalformedError(`unexpected assignment fields: ${unknown.join(', ')}`);
  if (typeof candidate.id !== 'string' || !candidate.id) throw new RequestMalformedError('assignment id is required');
  if (typeof candidate.title !== 'string' || !candidate.title) throw new RequestMalformedError('assignment title is required');
  if (typeof candidate.description !== 'string') throw new RequestMalformedError('assignment description must be a string');
  if (!Array.isArray(candidate.labels) || candidate.labels.some((label) => typeof label !== 'string')) {
    throw new RequestMalformedError('assignment labels must be an array of strings');
  }
  return candidate as unknown as WorkerTaskAssignment;
}

function completedTask(taskId: string, contextId: string, messageId: string): Task {
  return {
    id: taskId,
    contextId,
    status: {
      state: TaskState.TASK_STATE_COMPLETED,
      timestamp: new Date().toISOString(),
      message: {
        messageId,
        contextId,
        taskId,
        role: Role.ROLE_AGENT,
        parts: [{ content: { $case: 'text', value: 'Worker accepted and completed the assignment.' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
    },
    artifacts: [],
    history: [],
    metadata: undefined,
  };
}

function workerCard(options: WorkerA2ARouterOptions): AgentCard {
  const origin = options.baseUrl.replace(/\/$/, '');
  return {
    name: options.name,
    description: `Infinite Kanban worker running ${options.agentTypes.join(', ') || 'no'} agent(s).`,
    supportedInterfaces: [{ url: `${origin}${A2A_BASE_PATH}`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
    provider: { organization: 'Infinite Kanban', url: origin },
    version: options.version,
    documentationUrl: undefined,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: options.agentTypes.map((agentType) => ({
      id: `run-${agentType}`,
      name: `Run a task with ${agentType}`,
      description: `Execute a board task with ${agentType}.`,
      tags: ['code', agentType],
      examples: [],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    })),
    signatures: [],
    iconUrl: undefined,
  };
}

class WorkerAgentExecutor implements AgentExecutor {
  constructor(private readonly options: WorkerA2ARouterOptions) {}

  execute = async (request: RequestContext, events: ExecutionEventBus): Promise<void> => {
    if (request.task) throw new RequestMalformedError('worker task follow-ups are not supported yet');
    const assignment = assignmentFromMessage(request.userMessage);
    await this.options.dispatch(assignment);
    events.publish(AgentEvent.task(completedTask(request.taskId, request.contextId, `${request.taskId}-complete`)));
    events.finished();
  };

  cancelTask = async (taskId: string, events: ExecutionEventBus): Promise<void> => {
    await this.options.cancel?.(taskId);
    events.publish(AgentEvent.task({
      ...completedTask(taskId, '', `${taskId}-cancelled`),
      status: { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString(), message: undefined },
    }));
    events.finished();
  };
}

/** Mount a worker's JSON-RPC A2A endpoint and public Agent Card. */
export function createWorkerA2ARouter(options: WorkerA2ARouterOptions): Router {
  const requestHandler = new DefaultRequestHandler(
    workerCard(options),
    new InMemoryTaskStore(),
    new WorkerAgentExecutor(options),
  );
  const router = express.Router();
  router.use(AGENT_CARD_PATH, agentCardHandler({ agentCardProvider: requestHandler }));
  router.use(A2A_BASE_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  router.use(A2A_BASE_PATH, restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  return router;
}
