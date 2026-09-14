import type { JiraImportResult, Priority, Project, Task, TaskProvenance } from '../types.js';
import { buildTask } from '../routes/helpers.js';
import type { JiraIssue } from './client.js';
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from '@ai-agent-board/shared/constants.js';

interface IdempotentTaskRepository {
  createIdempotent(task: Task): Promise<{ task: Task; created: boolean }>;
}

export interface JiraImportDependencies {
  readonly repo: IdempotentTaskRepository;
  readonly project: Project;
  readonly issues: readonly JiraIssue[];
  readonly jiraBaseUrl: string;
}

const JIRA_TRIAGE_ALIAS = 'jira:triage';

function normalizeRouteKey(value: string): string {
  return value.trim().toLowerCase();
}

function issueRouteKeys(issue: JiraIssue): readonly string[] {
  return [...(issue.labels ?? []), ...(issue.components ?? [])]
    .map(normalizeRouteKey)
    .filter(Boolean);
}

function projectRouteKeys(project: Project): readonly string[] {
  return (project.aliases ?? [])
    .map(normalizeRouteKey)
    .filter((alias) => alias !== JIRA_TRIAGE_ALIAS);
}

function matchingProjects(issue: JiraIssue, routingProjects: readonly Project[]): readonly Project[] {
  const keys = new Set(issueRouteKeys(issue));
  return routingProjects.filter((project) =>
    projectRouteKeys(project).some((alias) => keys.has(alias)));
}

export function selectUnroutedJiraIssues(
  issues: readonly JiraIssue[],
  routingProjects: readonly Project[],
): readonly JiraIssue[] {
  return issues.filter((issue) => matchingProjects(issue, routingProjects).length !== 1);
}

/**
 * Select issues for a project's scheduled Jira import. Project aliases are exact,
 * case-insensitive matches against Jira labels and components; `jira:triage` is the
 * single catch-all project for unmatched or ambiguous issues.
 */
export function selectJiraIssuesForProject(
  issues: readonly JiraIssue[],
  targetProject: Project,
  routingProjects: readonly Project[],
): readonly JiraIssue[] {
  const triageProjects = routingProjects.filter((project) =>
    (project.aliases ?? []).some((alias) => normalizeRouteKey(alias) === JIRA_TRIAGE_ALIAS));

  return issues.filter((issue) => {
    const matches = matchingProjects(issue, routingProjects);

    if (matches.length === 1) return matches[0]?.id === targetProject.id;
    return triageProjects.length === 1 && triageProjects[0]?.id === targetProject.id;
  });
}

export function mapJiraPriority(priorityName: string | undefined): Priority | undefined {
  if (!priorityName) return undefined;

  const normalized = priorityName.trim().toLowerCase();
  if (!normalized) return undefined;

  if (['highest', 'critical', 'blocker', 'p0', 'sev0', 'sev1'].includes(normalized)) return 'critical';
  if (['high', 'major', 'p1', 'sev2'].includes(normalized)) return 'high';
  if (['medium', 'normal', 'moderate', 'p2', 'sev3'].includes(normalized)) return 'medium';
  if (['low', 'lowest', 'minor', 'trivial', 'p3', 'p4', 'sev4'].includes(normalized)) return 'low';

  return undefined;
}

function buildExternalKey(normalizedBaseUrl: string, issueId: string): string {
  return `${normalizedBaseUrl}::${issueId}`;
}

function buildIssueUrl(normalizedBaseUrl: string, issueKey: string): string {
  return `${normalizedBaseUrl}/browse/${encodeURIComponent(issueKey)}`;
}

function buildImportedBranchName(issue: JiraIssue): string {
  const slug = issue.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
  const suffix = issue.key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 10) || issue.id;
  return `agent/${slug}-${suffix}`;
}

function buildProvenance(issue: JiraIssue, normalizedBaseUrl: string): TaskProvenance {
  const projectLabel = issue.projectKey ?? issue.projectName ?? null;
  return {
    sourcePlatform: 'jira',
    origin: {
      jiraKey: issue.key,
      jiraStatus: issue.status,
      jiraType: issue.issueType,
      jiraProject: projectLabel,
      jiraUrl: buildIssueUrl(normalizedBaseUrl, issue.key),
      jiraCreated: issue.created ?? null,
      jiraUpdated: issue.updated ?? null,
    },
  };
}

function buildImportedTask(issue: JiraIssue, project: Project, normalizedBaseUrl: string): Task {
  const summary = issue.summary.trim();
  const title = (summary ? `${issue.key} ${summary}` : issue.key).slice(0, MAX_TITLE_LENGTH);
  const description = (issue.description || `Imported from Jira issue ${issue.key}`).slice(0, MAX_DESCRIPTION_LENGTH);
  const jiraPriority = mapJiraPriority(issue.priorityName);

  return buildTask({
    title,
    description,
    priority: jiraPriority ?? project.defaultPriority,
    columnId: 'backlog',
    projectId: project.id,
    repoPath: project.repoPath,
    agentType: project.defaultAgentType,
    baseBranch: project.defaultBaseBranch,
    branchName: project.defaultUseWorktree ? buildImportedBranchName(issue) : undefined,
      useWorktree: project.defaultUseWorktree,
     labels: issue.labels,
      externalSource: 'jira',
    externalKey: buildExternalKey(normalizedBaseUrl, issue.id),
    provenance: buildProvenance(issue, normalizedBaseUrl),
  });
}

export async function importAssignedJiraIssues(deps: JiraImportDependencies): Promise<JiraImportResult> {
  const createdTasks: Task[] = [];
  let skipped = 0;

  for (const issue of deps.issues) {
    const task = buildImportedTask(issue, deps.project, deps.jiraBaseUrl);
    const result = await deps.repo.createIdempotent(task);
    if (result.created) {
      createdTasks.push(result.task);
    } else {
      skipped += 1;
    }
  }

  return {
    total: deps.issues.length,
    created: createdTasks.length,
    skipped,
    tasks: createdTasks,
  };
}
