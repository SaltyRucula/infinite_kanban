import http from 'node:http';
import express, { type Router } from 'express';
import { Role, TaskState, type Message, type Task } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { BOARD_A2A_BASE_PATH, workerAgentCard } from '@ai-agent-board/a2a/cards.js';
import { assignmentFromMessage as decodeAssignment } from '@ai-agent-board/a2a/assignment.js';
import type { AgentType, WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import { parseA2AListenOptions, type A2AListenOptions } from './a2a-listen.js';

const AGENT_CARD_PATH = '/.well-known/agent-card.json';

export { parseA2AListenOptions, type A2AListenOptions };

export interface WorkerA2ARouterOptions {
  readonly baseUrl: string;
  readonly name: string;
  readonly version: string;
  readonly agentTypes: readonly AgentType[];
  readonly acceptedProjectIds?: readonly string[];
  readonly acceptedLabels?: readonly string[];
  readonly dispatch: (assignment: WorkerTaskAssignment, a2aTaskId: string) => Promise<void>;
  readonly cancel?: (taskId: string) => Promise<void>;
}

function assignmentFromMessage(message: Message): WorkerTaskAssignment {
  const decoded = decodeAssignment(message);
  if (!decoded.ok) throw new RequestMalformedError(decoded.error);
  return decoded.assignment;
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

class WorkerAgentExecutor implements AgentExecutor {
  constructor(private readonly options: WorkerA2ARouterOptions) {}

  execute = async (request: RequestContext, events: ExecutionEventBus): Promise<void> => {
    if (request.task) throw new RequestMalformedError('worker task follow-ups are not supported yet');
    const assignment = assignmentFromMessage(request.userMessage);
    await this.options.dispatch(assignment, request.taskId);
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
    workerAgentCard({
      baseUrl: options.baseUrl,
      name: options.name,
      version: options.version,
      agentTypes: options.agentTypes,
      authRequired: false,
      consent: {
        acceptedProjectIds: options.acceptedProjectIds ? [...options.acceptedProjectIds] : undefined,
        acceptedLabels: options.acceptedLabels ? [...options.acceptedLabels] : undefined,
      },
    }),
    new InMemoryTaskStore(),
    new WorkerAgentExecutor(options),
  );
  const router = express.Router();
  router.use(AGENT_CARD_PATH, agentCardHandler({ agentCardProvider: requestHandler }));
  router.use(BOARD_A2A_BASE_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  router.use(BOARD_A2A_BASE_PATH, restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  return router;
}

export type StartWorkerA2AServerOptions = Omit<WorkerA2ARouterOptions, 'baseUrl'> & A2AListenOptions;

export interface RunningWorkerA2AServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** Start a worker's A2A listener and advertise its actual bound loopback URL. */
export async function startWorkerA2AServer(options: StartWorkerA2AServerOptions): Promise<RunningWorkerA2AServer> {
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    const rejectListen = (error: Error): void => reject(error);
    server.once('error', rejectListen);
    server.listen(options.port, options.host, () => {
      server.off('error', rejectListen);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    throw new Error('worker A2A listener did not bind a TCP address');
  }
  const baseUrl = `http://${options.host}:${address.port}`;
  app.use(createWorkerA2ARouter({ ...options, baseUrl }));
  return {
    baseUrl,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
