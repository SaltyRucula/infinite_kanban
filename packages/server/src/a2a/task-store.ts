import { TaskState, type ListTasksRequest, type ListTasksResponse, type Task as A2ATask } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import { fromTaskState } from '@ai-agent-board/a2a/state.js';
import type { TaskRepository } from '../repositories/types.js';
import type { Task as BoardTask } from '../types.js';
import type { CancellationLog } from './cancellations.js';
import { toA2ATask } from './projection.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
/** How many board-less terminal tasks (refusals) stay readable before eviction. */
const MAX_EPHEMERAL_TASKS = 100;

function isTerminal(task: A2ATask): boolean {
  const state = task.status?.state;
  return state === TaskState.TASK_STATE_REJECTED
    || state === TaskState.TASK_STATE_FAILED
    || state === TaskState.TASK_STATE_CANCELED;
}

export interface BoardTaskStoreOptions {
  readonly taskRepo: TaskRepository;
  /** Builds the human deep link for a task, when the board knows its public URL. */
  readonly deepLink?: (taskId: string, projectId: string) => string;
  /** Shared record of tasks cancelled over A2A, so they project as cancelled. */
  readonly cancellations: CancellationLog;
  /**
   * Invoked when a cancelled status is written for a board-owned task. The SDK
   * cancels a task with no live execution bus by writing that status itself, so
   * this is where such a cancellation reaches the board.
   */
  readonly onCancel?: (taskId: string) => Promise<void>;
  /**
   * Lists every task the board holds, across all projects.
   *
   * `TaskRepository.getAll` is project-scoped and defaults to the `default`
   * project, so `ListTasks` must be given a cross-project reader or it silently
   * reports only one project's work.
   */
  readonly listAllTasks: () => Promise<readonly BoardTask[]>;
}

/**
 * A2A `TaskStore` backed by the board's own task repository.
 *
 * The board repository is the single source of truth: there is no second
 * table of A2A tasks to drift from it. `save` therefore does not write task
 * state — the board already owns it, and an A2A peer must not be able to move
 * a card by replaying a task object. It only asserts the task exists, so a
 * foreign task id can never be injected into the store.
 *
 * The one exception is a refused request: a rejected task has no board card by
 * definition, so it is kept in a small bounded map purely so the peer can read
 * back the refusal it was already told about.
 */
export class BoardTaskStore implements TaskStore {
  private readonly taskRepo: TaskRepository;
  private readonly deepLink?: (taskId: string, projectId: string) => string;
  private readonly cancellations: CancellationLog;
  private readonly onCancel?: (taskId: string) => Promise<void>;
  private readonly listAllTasks: () => Promise<readonly BoardTask[]>;
  private readonly ephemeral = new Map<string, A2ATask>();

  constructor(options: BoardTaskStoreOptions) {
    this.taskRepo = options.taskRepo;
    this.deepLink = options.deepLink;
    this.cancellations = options.cancellations;
    this.onCancel = options.onCancel;
    this.listAllTasks = options.listAllTasks;
  }

  private projectTask(task: BoardTask): A2ATask {
    return toA2ATask(task, {
      ...(this.deepLink ? { deepLink: this.deepLink(task.id, task.projectId) } : {}),
      ...(this.cancellations.has(task.id) ? { canceled: true } : {}),
    });
  }

  async save(task: A2ATask): Promise<void> {
    const existing = await this.taskRepo.getById(task.id);
    if (existing) {
      // Board state is authoritative, so a replayed task object cannot move a
      // card. Cancellation is the one transition a peer may drive, and the SDK
      // expresses it by writing a cancelled status for a task with no live
      // execution bus.
      if (task.status?.state === TaskState.TASK_STATE_CANCELED && !this.cancellations.has(task.id)) {
        await this.onCancel?.(task.id);
      }
      return;
    }

    // A request the board refused (or that failed during admission) has no card
    // by definition, yet the protocol still owes the peer a readable terminal
    // task. Those are kept briefly in memory; anything else with an unknown id
    // is a live task the board does not own and must not accept.
    if (isTerminal(task)) {
      if (this.ephemeral.size >= MAX_EPHEMERAL_TASKS) {
        const oldest = this.ephemeral.keys().next().value;
        if (oldest !== undefined) this.ephemeral.delete(oldest);
      }
      this.ephemeral.set(task.id, task);
      return;
    }
    throw new Error(`refusing to store an A2A task the board does not own: ${task.id}`);
  }

  async load(taskId: string): Promise<A2ATask | undefined> {
    const task = await this.taskRepo.getById(taskId);
    if (!task) return this.ephemeral.get(taskId);
    return this.projectTask(task);
  }

  async list(params: ListTasksRequest): Promise<ListTasksResponse> {
    const pageSize = Math.min(
      Math.max(params.pageSize && params.pageSize > 0 ? params.pageSize : DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const wanted = params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED
      ? fromTaskState(params.status).agentStatus
      : undefined;

    const all = await this.listAllTasks();
    const projected = all
      .filter((task) => !task.archived)
      .filter((task) => (wanted === undefined ? true : task.agentStatus === wanted))
      .map((task) => this.projectTask(task))
      .filter((task) => (params.contextId ? task.contextId === params.contextId : true))
      // Spec §3.1.4: most recently updated first.
      .sort((left, right) => (right.status?.timestamp ?? '').localeCompare(left.status?.timestamp ?? ''));

    const offset = decodePageToken(params.pageToken);
    const page = projected.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      tasks: params.includeArtifacts ? page : page.map(({ artifacts: _artifacts, ...rest }) => rest as A2ATask),
      nextPageToken: nextOffset < projected.length ? String(nextOffset) : '',
      pageSize,
      totalSize: projected.length,
    };
  }
}

function decodePageToken(token: string | undefined): number {
  if (!token) return 0;
  const parsed = Number.parseInt(token, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}
