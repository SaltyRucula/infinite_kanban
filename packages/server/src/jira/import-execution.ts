import type { Project, Task, JiraImportResult } from '../types.js';
import type { AgentEvent } from '../types.js';
import type { AgentInfo } from '../../../../shared/types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import { resolveJiraConfig, type JiraConfigResolution } from './config.js';
import { JiraClientError, JiraRestClient, type JiraIssue } from './client.js';
import { importAssignedJiraIssues, selectJiraIssuesForProject, selectUnroutedJiraIssues } from './importer.js';
import type { JiraRepositoryRouter } from './repository-router.js';
import { broadcastTaskUpdate, validateRepoPath } from '../routes/helpers.js';
import { findAgentInfo } from '../services/agent-availability.js';
import { broadcast } from '../websocket.js';
import { v4 as uuid } from 'uuid';

type ResolvedJiraConfig = Extract<JiraConfigResolution, { configured: true }>;

export type JiraImportTrigger = 'manual' | 'scheduled';

export type JiraImportExecutionOutcome =
  | { readonly status: 'completed'; readonly result: JiraImportResult }
  | { readonly status: 'skipped_overlap' };

export interface JiraImportExecutor {
  executeProjectImport(project: Project, trigger: JiraImportTrigger): Promise<JiraImportExecutionOutcome>;
  awaitIdle(timeoutMs: number): Promise<boolean>;
}

const MANUAL_IMPORT_CONFLICT_MESSAGE = 'Jira import already running for this project.';

export class JiraImportConflictError extends Error {
  constructor(message = MANUAL_IMPORT_CONFLICT_MESSAGE) {
    super(message);
  }
}

export class JiraImportNotConfiguredError extends Error {}

interface JiraIssueClient {
  listAssignedIssues(): Promise<readonly JiraIssue[]>;
}

export interface JiraImportExecutionDependencies {
  readonly taskRepo: Pick<TaskRepository, 'createIdempotent' | 'requestRun' | 'insertEvent'>;
  readonly projectRepo: Pick<ProjectRepository, 'update'>;
  readonly listRoutingProjects?: () => Promise<readonly Project[]>;
  readonly repositoryRouter?: JiraRepositoryRouter;
  readonly clientFactory?: (config: ResolvedJiraConfig) => JiraIssueClient;
  readonly configResolver?: () => JiraConfigResolution;
  readonly broadcaster?: (task: Task) => void;
  readonly eventBroadcaster?: (event: AgentEvent) => void;
  readonly listAvailableAgents?: () => readonly AgentInfo[];
  readonly repoPathValidator?: (repoPath: string) => { readonly valid: boolean; readonly error?: string };
  readonly onDurableRunRequested?: () => void | Promise<void>;
  readonly now?: () => number;
  readonly logger?: Pick<Console, 'info' | 'warn'>;
}

export interface SafeImportFailure {
  readonly category: 'jira_not_configured' | 'jira_auth' | 'jira_invalid_response' | 'jira_upstream' | 'unexpected';
  readonly message: string;
}

export function toSafeJiraImportFailure(error: unknown): SafeImportFailure {
  if (error instanceof JiraImportNotConfiguredError) {
    return { category: 'jira_not_configured', message: error.message };
  }
  if (error instanceof JiraClientError) {
    if (error.code === 'auth') {
      return { category: 'jira_auth', message: 'Jira authentication failed.' };
    }
    if (error.code === 'invalid_response') {
      return { category: 'jira_invalid_response', message: 'Jira returned an invalid response.' };
    }
    return { category: 'jira_upstream', message: 'Jira request failed.' };
  }
  return { category: 'unexpected', message: 'Unexpected Jira import failure.' };
}

export class JiraImportExecutionService implements JiraImportExecutor {
  private readonly activeProjectIds = new Set<string>();
  private readonly activeRuns = new Set<Promise<void>>();

  private readonly clientFactory: (config: ResolvedJiraConfig) => JiraIssueClient;

  private readonly configResolver: () => JiraConfigResolution;

  private readonly broadcaster: (task: Task) => void;

  private readonly now: () => number;

  private readonly logger: Pick<Console, 'info' | 'warn'>;

  private readonly eventBroadcaster: (event: AgentEvent) => void;

  private readonly listAvailableAgents: () => readonly AgentInfo[];

  private readonly repoPathValidator: (repoPath: string) => { readonly valid: boolean; readonly error?: string };

  private readonly onDurableRunRequested: () => void | Promise<void>;

  private readonly listRoutingProjects?: () => Promise<readonly Project[]>;

  private readonly repositoryRouter?: JiraRepositoryRouter;


  constructor(private readonly deps: JiraImportExecutionDependencies) {
    this.clientFactory = deps.clientFactory
      ?? ((resolvedConfig) => new JiraRestClient(resolvedConfig.config));
    this.configResolver = deps.configResolver ?? (() => resolveJiraConfig());
    this.broadcaster = deps.broadcaster ?? broadcastTaskUpdate;
    this.eventBroadcaster = deps.eventBroadcaster ?? ((event) => {
      broadcast({ type: 'agent_event', payload: event });
    });
    this.listAvailableAgents = deps.listAvailableAgents ?? (() => []);
    this.repoPathValidator = deps.repoPathValidator ?? validateRepoPath;
    this.onDurableRunRequested = deps.onDurableRunRequested ?? (() => undefined);
    this.listRoutingProjects = deps.listRoutingProjects;
    this.repositoryRouter = deps.repositoryRouter;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? console;
  }

  async executeProjectImport(project: Project, trigger: JiraImportTrigger): Promise<JiraImportExecutionOutcome> {
    if (this.activeProjectIds.has(project.id)) {
      if (trigger === 'manual') {
        throw new JiraImportConflictError();
      }
      return { status: 'skipped_overlap' };
    }

    this.activeProjectIds.add(project.id);
    const executionPromise = this.runProjectImport(project, trigger)
      .finally(() => {
        this.activeProjectIds.delete(project.id);
      });

    this.trackActiveRun(executionPromise);

    const result = await executionPromise;
    return { status: 'completed', result };
  }

  async awaitIdle(timeoutMs: number): Promise<boolean> {
    if (this.activeRuns.size === 0) return true;

    const deadline = this.now() + Math.max(0, timeoutMs);
    while (this.activeRuns.size > 0) {
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) return false;

      await Promise.race([
        Promise.allSettled([...this.activeRuns]),
        new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(remainingMs, 50));
        }),
      ]);
    }

    return true;
  }

  private trackActiveRun(runPromise: Promise<unknown>): void {
    const tracked = runPromise
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.activeRuns.delete(tracked);
      });
    this.activeRuns.add(tracked);
  }

  private async runProjectImport(project: Project, trigger: JiraImportTrigger): Promise<JiraImportResult> {
    const startedAt = this.now();
    await this.deps.projectRepo.update(project.id, {
      jiraImportLastRunAt: startedAt,
      updatedAt: startedAt,
    });

    try {
      const resolvedConfig = this.configResolver();
      if (!resolvedConfig.configured) {
        throw new JiraImportNotConfiguredError(resolvedConfig.reason);
      }

      const jiraClient = this.clientFactory(resolvedConfig);
      const assignedIssues = await jiraClient.listAssignedIssues();
      const issues = trigger === 'scheduled' && this.listRoutingProjects
        ? await this.selectScheduledIssues(assignedIssues, project, await this.listRoutingProjects())
        : assignedIssues;
      const result = await importAssignedJiraIssues({
        repo: this.deps.taskRepo,
        project,
        issues,
        jiraBaseUrl: resolvedConfig.config.normalizedBaseUrl,
      });

      for (const task of result.tasks) {
        this.broadcaster(task);
      }

      await this.requestDurableRunsForNewTasks(project, result.tasks);

      const completedAt = this.now();
      await this.deps.projectRepo.update(project.id, {
        jiraImportLastCompletedAt: completedAt,
        jiraImportLastSuccessAt: completedAt,
        jiraImportLastError: null,
        jiraImportLastTotal: result.total,
        jiraImportLastCreated: result.created,
        jiraImportLastSkipped: result.skipped,
        updatedAt: completedAt,
      });

      return result;
    } catch (error) {
      const completedAt = this.now();
      const safeFailure = toSafeJiraImportFailure(error);
      try {
        await this.deps.projectRepo.update(project.id, {
          jiraImportLastCompletedAt: completedAt,
          jiraImportLastError: `${safeFailure.category}: ${safeFailure.message}`,
          updatedAt: completedAt,
        });
      } catch {
        this.logger.warn(
          `[jira-import] failed to persist error metadata projectId=${project.id} projectName=${project.name} category=${safeFailure.category} message=${safeFailure.message}`,
        );
      }

      this.logger.warn(
        `[jira-import] projectId=${project.id} projectName=${project.name} category=${safeFailure.category} message=${safeFailure.message}`,
      );
      throw error;
    }
  }

  private async selectScheduledIssues(
    assignedIssues: readonly JiraIssue[],
    targetProject: Project,
    routingProjects: readonly Project[],
  ): Promise<readonly JiraIssue[]> {
    const explicitIssues = selectJiraIssuesForProject(assignedIssues, targetProject, routingProjects);
    if (!this.repositoryRouter) return explicitIssues;
    const unroutedIssues = selectUnroutedJiraIssues(assignedIssues, routingProjects);
    const triageProject = routingProjects.find((project) =>
      project.aliases?.some((alias) => alias.trim().toLowerCase() === 'jira:triage'));
    const candidates = routingProjects.filter((project) => project.repoPath && project.id !== triageProject?.id);
    const classifications = await Promise.all(unroutedIssues.map(async (issue) => ({
      issue,
      projectId: await this.repositoryRouter?.route(issue, candidates),
    })));

    if (targetProject.id === triageProject?.id) {
      const classifiedIssueIds = new Set(classifications.flatMap((item) => item.projectId ? [item.issue.id] : []));
      return explicitIssues.filter((issue) => !classifiedIssueIds.has(issue.id));
    }

    return [
      ...explicitIssues,
      ...classifications.filter((item) => item.projectId === targetProject.id).map((item) => item.issue),
    ];
  }

  private async requestDurableRunsForNewTasks(project: Project, tasks: readonly Task[]): Promise<void> {
    if (!project.jiraImportAutoStart || tasks.length === 0) {
      return;
    }

    const autoStartSkipReason = this.getAutoStartSkipReason(project);
    if (autoStartSkipReason) {
      for (const task of tasks) {
        await this.persistAutoStartSkipEvent(task, autoStartSkipReason);
      }
      return;
    }

    let requestedCount = 0;
    for (const task of tasks) {
      const requested = await this.deps.taskRepo.requestRun(task.id, this.now());
      if (!requested) {
        throw new Error(`failed to persist durable run request for imported task ${task.id}`);
      }
      requestedCount += 1;
    }

    if (requestedCount > 0) {
      await this.onDurableRunRequested();
    }
  }

  private getAutoStartSkipReason(project: Project): string | null {
    const repoPath = typeof project.repoPath === 'string' ? project.repoPath.trim() : '';
    if (!repoPath) {
      return 'Jira auto-start skipped: project repoPath is missing. Configure a repository path, then run this task manually.';
    }

    const repoPathValidation = this.repoPathValidator(repoPath);
    if (!repoPathValidation.valid) {
      const errorDetail = repoPathValidation.error ? ` (${repoPathValidation.error})` : '';
      return `Jira auto-start skipped: project repoPath is not usable${errorDetail}. Fix project repo settings, then run this task manually.`;
    }

    if (!project.defaultAgentType) {
      return 'Jira auto-start skipped: project default agent is not configured. Set a default agent, then run this task manually.';
    }

    const agentInfo = findAgentInfo(this.listAvailableAgents(), project.defaultAgentType);
    if (!agentInfo?.available) {
      const reason = agentInfo?.reason ? `: ${agentInfo.reason}` : '';
      return `Jira auto-start skipped: default agent ${project.defaultAgentType} is not available${reason}. Start/enable that agent, then run this task manually.`;
    }

    return null;
  }

  private async persistAutoStartSkipEvent(task: Task, content: string): Promise<void> {
    const event: AgentEvent = {
      id: uuid(),
      taskId: task.id,
      type: 'error',
      content,
      timestamp: this.now(),
      metadata: {
        agentType: task.agentType,
        duration: 0,
        error: content,
      },
    };

    await this.deps.taskRepo.insertEvent(event);
    this.eventBroadcaster(event);
  }
}
