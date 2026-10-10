import express, { type Router } from 'express';
import { DefaultRequestHandler, type User } from '@a2a-js/sdk/server';
import { TaskState } from '@a2a-js/sdk';
import { agentCardHandler, jsonRpcHandler, restHandler } from '@a2a-js/sdk/server/express';
import { BOARD_A2A_BASE_PATH, boardAgentCard } from '@ai-agent-board/a2a/cards.js';
import type { TaskRepository } from '../repositories/types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { AgentManager } from '../services/agent-manager.js';
import { authenticateToken } from '../middleware/auth.js';
import { getAllTasksAcrossProjects } from '../startup-recovery.js';
import { cancelBoardTask } from './cancel.js';
import { CancellationLog } from './cancellations.js';
import { A2APeerUser, BoardEventBusManager } from './call-context.js';
import { boardEvents, type BoardEventHub } from './event-hub.js';
import { BoardAgentExecutor } from './executor.js';
import { BoardTaskStore } from './task-store.js';

export const A2A_AGENT_CARD_PATH = '/.well-known/agent-card.json';
export { BOARD_A2A_BASE_PATH };

/** Scope a service token needs to send work to the board over A2A. */
export const A2A_SEND_SCOPE = 'a2a:send';

export interface A2ARouterOptions {
  readonly taskRepo: TaskRepository;
  readonly projectRepo: ProjectRepository;
  readonly agents: AgentManager;
  readonly boardVersion: string;
  /** Public origin peers reach this board on, e.g. `https://kanban.example.com`. */
  readonly publicUrl: string;
  /** Live board activity for streaming peers; defaults to the process-wide hub. */
  readonly events?: BoardEventHub;
}

const PEER_KEY = 'a2aPeer';
const STREAMING_KEY = 'a2aStreaming';

/**
 * Whether this request asked for a stream, decided from the request itself:
 * the JSON-RPC method for the JSON-RPC binding, the `:subscribe` suffix for
 * the REST binding. The marker then rides on the user so both the executor and
 * the bus manager can see it.
 */
export function isStreamingRequest(req: express.Request): boolean {
  const method = (req.body as { method?: unknown } | undefined)?.method;
  if (method === 'SendStreamingMessage' || method === 'SubscribeToTask') return true;
  if (typeof method === 'string') return false;
  // REST binding: POST /a2a/v1/message:stream, POST /a2a/v1/tasks/{id}:subscribe
  return /:(stream|subscribe)$/.test(req.path);
}

/**
 * Drops an unset `status` filter from a `ListTasks` call.
 *
 * The official `@a2a-js/sdk` client serializes "no status filter" as the proto
 * `UNRECOGNIZED` sentinel (`-1`), which the SDK's own server then refuses with
 * `Invalid status filter: -1` — so an unfiltered `listTasks()` from the
 * reference client fails against a stock server. Normalizing the sentinel to
 * absent here makes the common call work; a real filter is untouched and still
 * validated by the handler.
 *
 * Remove once the SDK stops emitting the sentinel (tracked in docs/a2a.md).
 */
export function normalizeListTasksStatus(req: express.Request): void {
  const body = req.body as { method?: unknown; params?: { status?: unknown } } | undefined;
  const isListTasks = body?.method === 'ListTasks' || /\/tasks$/.test(req.path);
  if (!isListTasks || !body?.params) return;
  const status = body.params.status;
  if (status === -1 || status === 'UNRECOGNIZED') delete body.params.status;
}

export function authRequired(): boolean {
  return Boolean(process.env.API_KEY) || Boolean(process.env.SERVICE_TOKENS);
}

/**
 * Authenticates an inbound A2A call with the board's existing credentials: the
 * full-access `API_KEY` or a service token carrying `a2a:send`. When neither is
 * configured the board is open (local dev) and the card advertises no scheme,
 * mirroring how `/api` already behaves.
 *
 * Runs as ordinary Express middleware so a refusal is a clean 401/403 instead
 * of an exception surfacing through the protocol handler as a server error.
 */
export function a2aAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.locals[STREAMING_KEY] = isStreamingRequest(req);
  normalizeListTasksStatus(req);
  if (!authRequired()) { next(); return; }

  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const auth = authenticateToken(token);
  if (!auth.authenticated) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (!auth.legacy && !auth.scopes.includes(A2A_SEND_SCOPE)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  res.locals[PEER_KEY] = auth.legacy ? 'legacy-admin' : auth.id ?? 'service';
  next();
}

/**
 * Maps the already-authenticated principal onto the SDK's user model, carrying
 * the streaming marker so bus lifetime can depend on the call (see
 * `call-context.ts`).
 */
export async function buildA2AUser(req: express.Request): Promise<User> {
  const locals = req.res?.locals as Record<string, unknown> | undefined;
  const principal = locals?.[PEER_KEY];
  const streaming = locals?.[STREAMING_KEY] === true;
  return typeof principal === 'string'
    ? new A2APeerUser(principal, streaming, true)
    : new A2APeerUser('anonymous', streaming, false);
}

/**
 * Mounts the board as an A2A server: its Agent Card plus the JSON-RPC and
 * HTTP+JSON bindings of `SendMessage`, `GetTask`, `ListTasks` and `CancelTask`.
 */
export function createA2ARouter(options: A2ARouterOptions): Router {
  const deepLink = (taskId: string, projectId: string): string =>
    `${options.publicUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;

  const card = boardAgentCard({
    baseUrl: options.publicUrl,
    version: options.boardVersion,
    authRequired: authRequired(),
  });

  const cancellations = new CancellationLog();
  const cancelDeps = { taskRepo: options.taskRepo, agents: options.agents, cancellations };
  const requestHandler = new DefaultRequestHandler(
    card,
    new BoardTaskStore({
      taskRepo: options.taskRepo,
      deepLink,
      cancellations,
      onCancel: async (taskId) => { await cancelBoardTask(cancelDeps, taskId); },
      listAllTasks: () => getAllTasksAcrossProjects(options.projectRepo, options.taskRepo),
    }),
    new BoardAgentExecutor({
      taskRepo: options.taskRepo,
      projectRepo: options.projectRepo,
      agents: options.agents,
      deepLink,
      cancellations,
      events: options.events ?? boardEvents,
    }),
    new BoardEventBusManager(),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      // Bus lifetime is decided per call by BoardEventBusManager (streaming
      // keeps it, blocking sends settle immediately). These states apply only
      // to the calls that manager declines, and match the SDK default of
      // keeping an interrupted run attachable.
      keepBusAliveStates: [
        TaskState.TASK_STATE_INPUT_REQUIRED,
        TaskState.TASK_STATE_AUTH_REQUIRED,
      ],
    },
  );

  const router = express.Router();
  // The card is public discovery metadata (spec §8.2) and carries no task data.
  router.use(A2A_AGENT_CARD_PATH, agentCardHandler({ agentCardProvider: requestHandler }));
  router.use(BOARD_A2A_BASE_PATH, a2aAuthMiddleware);
  router.use(BOARD_A2A_BASE_PATH, jsonRpcHandler({ requestHandler, userBuilder: buildA2AUser }));
  router.use(BOARD_A2A_BASE_PATH, restHandler({ requestHandler, userBuilder: buildA2AUser }));
  return router;
}
