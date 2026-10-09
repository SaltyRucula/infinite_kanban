import express, { type Router } from 'express';
import { DefaultRequestHandler, UnauthenticatedUser, type User } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, restHandler } from '@a2a-js/sdk/server/express';
import { BOARD_A2A_BASE_PATH, boardAgentCard } from '@ai-agent-board/a2a/cards.js';
import type { TaskRepository } from '../repositories/types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { AgentManager } from '../services/agent-manager.js';
import { authenticateToken } from '../middleware/auth.js';
import { cancelBoardTask } from './cancel.js';
import { CancellationLog } from './cancellations.js';
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
}

class A2APeer implements User {
  constructor(private readonly principal: string) {}
  get isAuthenticated(): boolean { return true; }
  get userName(): string { return this.principal; }
}

const PEER_KEY = 'a2aPeer';

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

/** Maps the already-authenticated principal onto the SDK's user model. */
export async function buildA2AUser(req: express.Request): Promise<User> {
  const principal = (req.res?.locals as Record<string, unknown> | undefined)?.[PEER_KEY];
  return typeof principal === 'string' ? new A2APeer(principal) : new UnauthenticatedUser();
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
    }),
    new BoardAgentExecutor({
      taskRepo: options.taskRepo,
      projectRepo: options.projectRepo,
      agents: options.agents,
      deepLink,
      cancellations,
    }),
  );

  const router = express.Router();
  // The card is public discovery metadata (spec §8.2) and carries no task data.
  router.use(A2A_AGENT_CARD_PATH, agentCardHandler({ agentCardProvider: requestHandler }));
  router.use(BOARD_A2A_BASE_PATH, a2aAuthMiddleware);
  router.use(BOARD_A2A_BASE_PATH, jsonRpcHandler({ requestHandler, userBuilder: buildA2AUser }));
  router.use(BOARD_A2A_BASE_PATH, restHandler({ requestHandler, userBuilder: buildA2AUser }));
  return router;
}
