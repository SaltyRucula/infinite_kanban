import type { JiraImportResult, Priority, Project, Task, TaskProvenance } from '../types.js';
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from '@ai-agent-board/shared/constants.js';
import { buildTask } from '../routes/helpers.js';
import type { GitHubIssue } from './client.js';

interface IdempotentTaskRepository {
  createIdempotent(task: Task): Promise<{ task: Task; created: boolean }>;
}

export interface GitHubImportDependencies {
  readonly repo: IdempotentTaskRepository;
  readonly project: Project;
  readonly issues: readonly GitHubIssue[];
}

function repositoryKey(repositoryUrl: string): string {
  const url = new URL(repositoryUrl);
  return url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
}

function priorityFromLabels(labels: readonly string[]): Priority | undefined {
  const normalized = new Set(labels.map((label) => label.trim().toLowerCase()));
  if (normalized.has('priority:p0')) return 'critical';
  if (normalized.has('priority:p1')) return 'high';
  if (normalized.has('priority:p2')) return 'medium';
  return undefined;
}

function branchName(issue: GitHubIssue): string {
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'issue';
  return `agent/github-${issue.number}-${slug}`;
}

function provenance(issue: GitHubIssue): TaskProvenance {
  return {
    sourcePlatform: 'github',
    origin: {
      githubIssueNumber: issue.number,
      githubUrl: issue.url,
      githubCreatedAt: issue.createdAt ?? null,
      githubUpdatedAt: issue.updatedAt ?? null,
    },
  };
}

function toTask(issue: GitHubIssue, project: Project): Task {
  const repository = repositoryKey(project.repoUrl ?? '');
  return buildTask({
    title: `#${issue.number} ${issue.title}`.slice(0, MAX_TITLE_LENGTH),
    description: (issue.description || `Imported from GitHub issue #${issue.number}`).slice(0, MAX_DESCRIPTION_LENGTH),
    priority: priorityFromLabels(issue.labels) ?? project.defaultPriority,
    columnId: 'backlog',
    projectId: project.id,
    repoPath: project.repoPath,
    agentType: project.defaultAgentType,
    baseBranch: project.defaultBaseBranch,
    branchName: project.defaultUseWorktree ? branchName(issue) : undefined,
    useWorktree: project.defaultUseWorktree,
    labels: issue.labels,
    externalSource: 'github',
    externalKey: `${repository}#${issue.number}`,
    provenance: provenance(issue),
  });
}

export async function importGitHubIssues(deps: GitHubImportDependencies): Promise<JiraImportResult> {
  const tasks: Task[] = [];
  let skipped = 0;
  for (const issue of deps.issues) {
    const result = await deps.repo.createIdempotent(toTask(issue, deps.project));
    if (result.created) tasks.push(result.task);
    else skipped += 1;
  }
  return { total: deps.issues.length, created: tasks.length, skipped, tasks };
}
