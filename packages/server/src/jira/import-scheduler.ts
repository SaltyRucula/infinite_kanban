import type { Project } from '../types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { TaskRepository } from '../repositories/types.js';
import {
  DEFAULT_JIRA_IMPORT_INTERVAL_MINUTES,
  DEFAULT_JIRA_IMPORT_ENABLED,
} from './schedule-config.js';
import { toSafeJiraImportFailure, type JiraImportExecutor } from './import-execution.js';

const DEFAULT_TICK_MS = 30_000;
const IDLE_JIRA_IMPORT_INTERVAL_MINUTES = 5;

export interface JiraImportSchedulerDependencies {
  readonly projectRepo: Pick<ProjectRepository, 'getAllWithCounts'>;
  readonly taskRepo?: Pick<TaskRepository, 'getAll'>;
  readonly importExecutor: JiraImportExecutor;
  readonly tickMs?: number;
  readonly now?: () => number;
  readonly logger?: Pick<Console, 'info' | 'warn'>;
}

export function isProjectDueForJiraImport(project: Project, now: number, isIdle = false): boolean {
  const enabled = project.jiraImportEnabled ?? DEFAULT_JIRA_IMPORT_ENABLED;
  if (!enabled) return false;

  const intervalMinutes = Number.isInteger(project.jiraImportIntervalMinutes)
    ? project.jiraImportIntervalMinutes
    : DEFAULT_JIRA_IMPORT_INTERVAL_MINUTES;
  const effectiveIntervalMinutes = isIdle
    ? Math.min(intervalMinutes, IDLE_JIRA_IMPORT_INTERVAL_MINUTES)
    : intervalMinutes;
  const intervalMs = effectiveIntervalMinutes * 60_000;
  const lastRunAt = project.jiraImportLastRunAt ?? 0;

  return now - lastRunAt >= intervalMs;
}

export class JiraImportScheduler {
  private timer: NodeJS.Timeout | undefined;

  private tickInProgress = false;

  private manualTickRequested = false;

  private stopped = true;

  private readonly tickMs: number;

  private readonly now: () => number;

  private readonly logger: Pick<Console, 'info' | 'warn'>;

  constructor(private readonly deps: JiraImportSchedulerDependencies) {
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? console;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    this.timer.unref();
    this.requestTick();
  }

  stop(): void {
    this.stopped = true;
    this.manualTickRequested = false;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  requestTick(): void {
    if (this.stopped) return;
    this.manualTickRequested = true;
    queueMicrotask(() => {
      void this.tick();
    });
  }

  async awaitIdle(timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + Math.max(0, timeoutMs);
    while (this.tickInProgress) {
      if (this.now() >= deadline) {
        return false;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }

    const remainingMs = Math.max(0, deadline - this.now());
    return this.deps.importExecutor.awaitIdle(remainingMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.tickInProgress) return;
    this.manualTickRequested = false;
    this.tickInProgress = true;
    try {
      const now = this.now();
      const projects = await this.deps.projectRepo.getAllWithCounts();
      const projectTasks = await Promise.all(projects.map((project) =>
        this.deps.taskRepo?.getAll(false, project.id) ?? Promise.resolve([])));
      const isIdle = !projectTasks.flat().some((task) =>
        task.agentStatus === 'planning' || task.agentStatus === 'executing');
      const dueProjects = projects.filter((project) => isProjectDueForJiraImport(project, now, isIdle));
      await Promise.all(dueProjects.map(async (project) => {
        if (this.stopped) return;
        try {
          const outcome = await this.deps.importExecutor.executeProjectImport(project, 'scheduled');
          if (outcome.status === 'skipped_overlap') {
            this.logger.info(
              `[jira-import-scheduler] skipped overlapping run projectId=${project.id} projectName=${project.name}`,
            );
          }
        } catch (error) {
          const safeFailure = toSafeJiraImportFailure(error);
          this.logger.warn(
            `[jira-import-scheduler] failed run projectId=${project.id} projectName=${project.name} category=${safeFailure.category} message=${safeFailure.message}`,
          );
        }
      }));
    } finally {
      this.tickInProgress = false;
      if (!this.stopped && this.manualTickRequested) {
        queueMicrotask(() => {
          void this.tick();
        });
      }
    }
  }
}
