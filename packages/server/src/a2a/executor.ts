import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server';
import { Role, TaskState } from '@a2a-js/sdk';
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { BOARD_EXTENSION_URI } from '@ai-agent-board/a2a/extension.js';
import type { TaskRepository } from '../repositories/types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { AgentManager } from '../services/agent-manager.js';
import { findAgentInfo } from '../services/agent-availability.js';
import { broadcastTaskUpdate, buildTask, startAgentForTask } from '../routes/helpers.js';
import { cancelBoardTask } from './cancel.js';
import type { CancellationLog } from './cancellations.js';
import { intakeWorkRequest, type BoardWorkRequest } from './intake.js';
import { contextIdFor, toA2ATask } from './projection.js';
import type { Task } from '../types.js';

export interface BoardAgentExecutorOptions {
  readonly taskRepo: TaskRepository;
  readonly projectRepo: ProjectRepository;
  readonly agents: AgentManager;
  readonly deepLink?: (taskId: string, projectId: string) => string;
  /** Shared with the task store so a cancelled run projects as cancelled. */
  readonly cancellations: CancellationLog;
}

/** Marks the board's refusal to take the work at all (A2A `TASK_STATE_REJECTED`). */
class WorkRejectedError extends Error {}

function branchNameFor(key: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
  const suffix = key.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toLowerCase() || Date.now().toString(36);
  return `agent/${slug}-${suffix}`;
}

/**
 * Serves inbound A2A work: another agent or an orchestrator sends a message,
 * the board admits it, creates a ticket, and reports the ticket as an A2A task.
 *
 * The board does not execute the work inside this call — a run can take an
 * hour and is carried out by the normal execution path (worker or in-process
 * agent manager). The executor therefore publishes the task and returns; the
 * peer follows progress with `GetTask`, a stream, or a push notification.
 */
export class BoardAgentExecutor implements AgentExecutor {
  private readonly taskRepo: TaskRepository;
  private readonly projectRepo: ProjectRepository;
  private readonly agents: AgentManager;
  private readonly deepLink?: (taskId: string, projectId: string) => string;
  private readonly cancellations: CancellationLog;

  constructor(options: BoardAgentExecutorOptions) {
    this.taskRepo = options.taskRepo;
    this.projectRepo = options.projectRepo;
    this.agents = options.agents;
    this.deepLink = options.deepLink;
    this.cancellations = options.cancellations;
  }

  execute = async (requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> => {
    const message = requestContext.userMessage;

    // A message carrying a task id continues that task instead of starting new
    // work (spec §3.4.3).
    if (requestContext.task) {
      await this.continueTask(requestContext, eventBus);
      return;
    }

    const intake = intakeWorkRequest(message);
    if (!intake.ok) throw new RequestMalformedError(intake.error);

    let task: Task;
    try {
      task = await this.admitAndCreate(intake.request);
    } catch (error) {
      if (error instanceof WorkRejectedError) {
        this.publishRejection(requestContext, eventBus, error.message);
        return;
      }
      throw error;
    }

    // The response is the admitted task, not the finished work: a run takes
    // minutes to an hour and is carried out by the normal execution path. The
    // peer follows it with `GetTask`, a stream, or a push notification.
    eventBus.publish(AgentEvent.task(this.project(task)));
    eventBus.finished();
  };

  cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    const cleared = await cancelBoardTask(
      { taskRepo: this.taskRepo, agents: this.agents, cancellations: this.cancellations },
      taskId,
    );
    if (!cleared) throw new TaskNotFoundError(`task ${taskId} does not exist`);
    eventBus.publish(AgentEvent.task(this.project(cleared, { canceled: true })));
    eventBus.finished();
  };

  private async continueTask(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const existing = requestContext.task;
    if (!existing) throw new TaskNotFoundError('no task to continue');
    const task = await this.taskRepo.getById(existing.id);
    if (!task) throw new TaskNotFoundError(`task ${existing.id} does not exist`);

    const text = requestContext.userMessage.parts
      .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
      .filter((value) => value.length > 0)
      .join('\n')
      .trim();
    if (!text) throw new RequestMalformedError('a follow-up message must contain text');

    const delivered = await this.agents.sendMessage(task.id, text);
    if (!delivered) {
      throw new UnsupportedOperationError(
        `task ${task.id} has no running agent to receive a follow-up; its state is ${task.agentStatus}`,
      );
    }
    eventBus.publish(AgentEvent.task(this.project(task)));
    eventBus.finished();
  }

  /**
   * Board-side admission: resolve the project, confirm it can host coding work,
   * confirm the requested agent is ready, then create the ticket idempotently.
   * The repository path is read from the project here and never from the peer.
   */
  private async admitAndCreate(request: BoardWorkRequest): Promise<Task> {
    const matches = await this.projectRepo.resolve(request.project);
    if (matches.length === 0) throw new WorkRejectedError(`project not found: ${request.project}`);
    if (matches.length > 1) {
      throw new WorkRejectedError(
        `project reference is ambiguous: ${matches.map((project) => project.name).join(', ')}`,
      );
    }
    const project = matches[0];
    if (!project.repoPath) {
      throw new WorkRejectedError('project must have a repository path before coding work can start');
    }

    const agentType = request.agentType ?? project.defaultAgentType ?? 'opencode';
    if (request.autoStart) {
      const ready = findAgentInfo(this.agents.getAvailableAgents(), agentType);
      if (!ready?.available) {
        throw new WorkRejectedError(`agent ${agentType} is not ready${ready?.reason ? `: ${ready.reason}` : ''}`);
      }
    }

    const baseBranch = request.baseBranch ?? project.defaultBaseBranch ?? 'main';
    const branchName = request.branchName ?? branchNameFor(request.idempotencyKey, request.title);

    const task = buildTask({
      title: request.title,
      description: request.description,
      projectId: project.id,
      agentType,
      priority: request.priority ?? project.defaultPriority,
      columnId: request.autoStart ? 'in-progress' : 'backlog',
      baseBranch,
      branchName,
      useWorktree: true,
      externalSource: 'a2a',
      externalKey: request.idempotencyKey,
      ...(request.provenance ? { provenance: request.provenance } : {}),
      ...(request.autoStart ? { runRequestedAt: Date.now() } : {}),
      ...(request.timeoutMinutes === undefined ? {} : { timeoutMinutes: request.timeoutMinutes }),
      ...(request.labels === undefined ? {} : { labels: [...request.labels] }),
    });
    // buildTask strips host paths for worker portability; an inbound A2A task
    // runs on this host in a worktree of the project's own repository.
    task.repoPath = project.repoPath;

    const result = await this.taskRepo.createIdempotent(task);
    if (!result.created) {
      // A replayed messageId returns the original task rather than duplicating
      // work (spec §3.3.1).
      return result.task;
    }

    broadcastTaskUpdate(task);
    if (request.autoStart) {
      queueMicrotask(() => {
        void startAgentForTask(task, this.taskRepo, this.agents).catch((error: unknown) => {
          console.error(`[a2a] failed to dispatch task ${task.id}:`, error);
        });
      });
    }
    return await this.taskRepo.getById(task.id) ?? task;
  }

  private publishRejection(requestContext: RequestContext, eventBus: ExecutionEventBus, reason: string): void {
    const contextId = requestContext.contextId;
    eventBus.publish(AgentEvent.task({
      id: requestContext.taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_REJECTED,
        message: {
          messageId: `${requestContext.taskId}-rejected`,
          contextId,
          taskId: requestContext.taskId,
          role: Role.ROLE_AGENT,
          parts: [{ content: { $case: 'text', value: reason }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
          metadata: undefined,
          extensions: [BOARD_EXTENSION_URI],
          referenceTaskIds: [],
        },
        timestamp: new Date().toISOString(),
      },
      artifacts: [],
      history: [],
      metadata: undefined,
    }));
    eventBus.finished();
  }

  private project(task: Task, options: { readonly canceled?: boolean } = {}) {
    return toA2ATask(task, {
      ...(this.deepLink ? { deepLink: this.deepLink(task.id, task.projectId) } : {}),
      ...(options.canceled ? { canceled: true } : {}),
    });
  }
}

export { contextIdFor };
