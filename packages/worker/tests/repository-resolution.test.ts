import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import { canonicalRepoUrl, resolveRepositoryWorkspace } from '../src/repository-resolution.js';

test('a non-default port is part of the repository identity', () => {
  // Two self-hosted Git servers can share a host and differ only by port;
  // dropping the port silently merges them into one repository.
  assert.notEqual(
    canonicalRepoUrl('https://git.example.com:8443/owner/repo.git'),
    canonicalRepoUrl('https://git.example.com/owner/repo.git'),
  );
  assert.equal(canonicalRepoUrl('https://git.example.com:8443/owner/repo.git'), 'git.example.com:8443/owner/repo');
  // Default ports are not part of it, so the same server written two ways matches.
  assert.equal(canonicalRepoUrl('https://git.example.com:443/owner/repo'), 'git.example.com/owner/repo');
  assert.equal(canonicalRepoUrl('ssh://git@git.example.com:22/owner/repo.git'), 'git.example.com/owner/repo');
});

test('the canonical key is accepted back as a mapping key', () => {
  // `github.com/owner/repo` is the form users see in "no local checkout is
  // configured for ..." errors, so pasting it into repositoryMappings has to
  // match rather than silently never matching.
  assert.equal(canonicalRepoUrl('github.com/owner/repo'), 'github.com/owner/repo');
  assert.equal(canonicalRepoUrl('git.example.com:8443/owner/repo'), 'git.example.com:8443/owner/repo');
  assert.equal(
    canonicalRepoUrl(canonicalRepoUrl('git@github.com:owner/repo.git')),
    canonicalRepoUrl('git@github.com:owner/repo.git'),
  );
});

test('genuine garbage is still rejected, not turned into an unmatchable key', () => {
  for (const bad of ['', '   ', 'not a remote', 'owner/repo', 'file:///srv/repos/thing.git']) {
    assert.throws(() => canonicalRepoUrl(bad), /repository identity/, JSON.stringify(bad));
  }
});

const assignment: WorkerTaskAssignment = {
  id: 'task-1',
  title: 'Implement repository-aware worker routing',
  description: 'Use the repository coordinates carried by the assignment.',
  priority: 'high',
  labels: [],
  repoUrl: 'https://github.com/Acme/board.git',
  baseBranch: 'main',
};

test('canonicalRepoUrl removes transport-only differences without exposing a local path', () => {
  assert.equal(canonicalRepoUrl('git@github.com:Acme/board.git'), 'github.com/acme/board');
  assert.equal(canonicalRepoUrl('https://github.com/acme/board/'), 'github.com/acme/board');
});

test('resolveRepositoryWorkspace uses the configured repository mapping instead of guessing a sibling directory', async () => {
  const calls: string[] = [];
  const resolved = await resolveRepositoryWorkspace(assignment, {
    workspacePath: '/worker/workspace',
    repositoryMappings: { 'github.com/acme/board': '/repos/board' },
  }, {
    isDirectory: async (directory) => directory === '/repos/board',
    runGit: async (...args) => { calls.push(args.join(' ')); },
  });

  assert.equal(resolved, '/repos/board');
  assert.deepEqual(calls, ['-C /repos/board fetch --prune origin']);
});

test('resolveRepositoryWorkspace clones an unmapped repository under cloneRoot', async () => {
  const calls: string[] = [];
  const directories: string[] = [];
  const resolved = await resolveRepositoryWorkspace(assignment, {
    workspacePath: '/worker/workspace',
    cloneRoot: '/worker/clones',
  }, {
    isDirectory: async () => false,
    mkdir: async (directory) => { directories.push(directory); },
    runGit: async (...args) => { calls.push(args.join(' ')); },
  });

  assert.equal(resolved, '/worker/clones/github.com/acme/board');
  assert.deepEqual(directories, ['/worker/clones/github.com/acme']);
  assert.deepEqual(calls, ['clone -- https://github.com/Acme/board.git /worker/clones/github.com/acme/board']);
});

test('resolveRepositoryWorkspace retains the configured workspace when a legacy assignment has no repository identity', async () => {
  const resolved = await resolveRepositoryWorkspace({ ...assignment, repoUrl: undefined }, {
    workspacePath: '/worker/workspace',
  });

  assert.equal(resolved, '/worker/workspace');
});
