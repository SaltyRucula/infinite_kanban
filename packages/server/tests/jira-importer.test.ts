import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Task } from '../src/types.js';
import { importAssignedJiraIssues, mapJiraPriority, selectJiraIssuesForProject } from '../src/jira/importer.js';
import type { JiraIssue } from '../src/jira/client.js';

class FakeTaskRepository {
  readonly createdTasks: Task[] = [];
  private readonly identityMap = new Map<string, Task>();

  async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
    const key = `${task.externalSource ?? ''}:${task.externalKey ?? ''}`;
    const existing = this.identityMap.get(key);
    if (existing) {
      return { task: existing, created: false };
    }

    this.identityMap.set(key, task);
    this.createdTasks.push(task);
    return { task, created: true };
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'default',
    name: 'Default',
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
    defaultPriority: 'medium',
    defaultAgentType: 'copilot',
    ...overrides,
  };
}

test('mapJiraPriority maps common Jira values', () => {
  assert.equal(mapJiraPriority('Highest'), 'critical');
  assert.equal(mapJiraPriority('High'), 'high');
  assert.equal(mapJiraPriority('Medium'), 'medium');
  assert.equal(mapJiraPriority('Lowest'), 'low');
  assert.equal(mapJiraPriority('Unknown'), undefined);
});

test('selectJiraIssuesForProject routes a matching label, sends unmatched issues to triage, and excludes ambiguous matches', () => {
  const tellurium = makeProject({ id: 'tellurium', aliases: ['intvis.tellurium'] });
  const infrastructure = makeProject({ id: 'infrastructure', aliases: ['intvis.infrastructure'] });
  const triage = makeProject({ id: 'triage', aliases: ['jira:triage'] });
  const ambiguous = makeProject({ id: 'ambiguous', aliases: ['intvis.tellurium'] });

  const telluriumIssue = makeIssue({ id: '10001', labels: ['Intvis.Tellurium'] });
  const unmatchedIssue = makeIssue({ id: '10002', key: 'PROJ-2' });

  assert.deepEqual(
    selectJiraIssuesForProject([telluriumIssue, unmatchedIssue], tellurium, [tellurium, infrastructure, triage]),
    [telluriumIssue],
  );
  assert.deepEqual(
    selectJiraIssuesForProject([telluriumIssue, unmatchedIssue], triage, [tellurium, infrastructure, triage]),
    [unmatchedIssue],
  );
  assert.deepEqual(
    selectJiraIssuesForProject([telluriumIssue], tellurium, [tellurium, ambiguous, triage]),
    [],
  );
});

function makeIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '10000',
    key: 'PROJ-1',
    summary: 'Imported issue',
    description: 'desc',
    status: 'To Do',
    issueType: 'Task',
    ...overrides,
  };
}

test('importAssignedJiraIssues creates only new tasks and preserves external identity', async () => {
  const repo = new FakeTaskRepository();
  const project = makeProject({
    id: 'proj-123',
    name: 'Demo',
    repoPath: '/tmp/demo-repo',
    defaultPriority: 'medium',
    defaultAgentType: 'claude',
    defaultBaseBranch: 'main',
    defaultUseWorktree: true,
  });

  const issues: JiraIssue[] = [
    {
      id: '10001',
      key: 'PROJ-11',
      summary: 'Fix login bug',
      description: 'Investigate login behavior',
      status: 'In Progress',
      issueType: 'Bug',
      priorityName: 'High',
      projectKey: 'PROJ',
      projectName: 'Project',
      created: '2026-08-10T00:00:00.000+0000',
      updated: '2026-08-10T01:00:00.000+0000',
      labels: ['Backend', 'backend', 'Intvis.Demo'],
    },
    {
      id: '10001',
      key: 'PROJ-11',
      summary: 'Fix login bug duplicate',
      description: 'Duplicate should be skipped',
      status: 'In Progress',
      issueType: 'Bug',
      priorityName: 'High',
      projectKey: 'PROJ',
      projectName: 'Project',
      created: '2026-08-10T00:00:00.000+0000',
      updated: '2026-08-10T01:00:00.000+0000',
    },
    {
      id: '10002',
      key: 'PROJ-22',
      summary: 'Refactor worker',
      description: '',
      status: 'To Do',
      issueType: 'Task',
      priorityName: undefined,
      projectKey: 'PROJ',
      projectName: 'Project',
      created: '2026-08-09T00:00:00.000+0000',
      updated: '2026-08-10T02:00:00.000+0000',
    },
  ];

  const result = await importAssignedJiraIssues({
    repo,
    project,
    issues,
    jiraBaseUrl: 'https://jira.example.com',
  });

  assert.equal(result.total, 3);
  assert.equal(result.created, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.tasks.length, 2);
  assert.equal(repo.createdTasks.length, 2);

  const first = result.tasks[0];
  assert.equal(first.externalSource, 'jira');
  assert.equal(first.externalKey, 'https://jira.example.com::10001');
  assert.equal(first.priority, 'high');
  assert.equal(first.projectId, 'proj-123');
  assert.equal(first.columnId, 'backlog');
  assert.equal(first.repoPath, undefined);
  assert.equal(first.agentType, 'claude');
  assert.equal(first.baseBranch, 'main');
  assert.equal(first.useWorktree, true);
  assert.deepEqual(first.labels, ['backend', 'intvis.demo']);
  assert.equal(first.branchName, 'agent/fix-login-bug-proj11');
  assert.equal(first.provenance?.sourcePlatform, 'jira');
  assert.equal(first.provenance?.origin?.jiraKey, 'PROJ-11');
  assert.equal(first.provenance?.origin?.jiraStatus, 'In Progress');
  assert.equal(first.provenance?.origin?.jiraType, 'Bug');
  assert.equal(first.provenance?.origin?.jiraProject, 'PROJ');
  assert.equal(first.provenance?.origin?.jiraUrl, 'https://jira.example.com/browse/PROJ-11');
  assert.equal(first.provenance?.origin?.jiraCreated, '2026-08-10T00:00:00.000+0000');
  assert.equal(first.provenance?.origin?.jiraUpdated, '2026-08-10T01:00:00.000+0000');

  const second = result.tasks[1];
  assert.equal(second.priority, 'medium');
  assert.equal(second.description, 'Imported from Jira issue PROJ-22');
});
