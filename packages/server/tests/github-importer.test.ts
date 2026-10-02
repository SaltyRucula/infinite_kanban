import assert from 'node:assert/strict';
import test from 'node:test';
import { importGitHubIssues } from '../src/github/importer.js';
import type { GitHubIssue } from '../src/github/client.js';
import type { Project, Task } from '../src/types.js';

const project: Project = {
  id: 'project-1', name: 'Board', repoUrl: 'https://github.com/acme/board.git', isDefault: true,
  createdAt: 1, updatedAt: 1, defaultPriority: 'medium', defaultAgentType: 'opencode',
};

const issue: GitHubIssue = {
  id: '101', number: 7, title: 'Track GitHub issues', description: 'Import open issues into the board.',
  url: 'https://github.com/acme/board/issues/7', labels: ['priority:p1', 'area:server'],
};

test('importGitHubIssues creates an idempotent backlog task with GitHub provenance and mapped priority', async () => {
  const created: Task[] = [];
  const result = await importGitHubIssues({
    project,
    issues: [issue],
    repo: {
      async createIdempotent(task) {
        created.push(task);
        return { task, created: true };
      },
    },
  });

  assert.equal(result.created, 1);
  assert.equal(result.skipped, 0);
  assert.equal(created[0].title, '#7 Track GitHub issues');
  assert.equal(created[0].priority, 'high');
  assert.equal(created[0].externalSource, 'github');
  assert.equal(created[0].externalKey, 'acme/board#7');
  assert.equal(created[0].provenance?.origin?.githubUrl, issue.url);
  assert.deepEqual(created[0].labels, ['priority:p1', 'area:server']);
});
