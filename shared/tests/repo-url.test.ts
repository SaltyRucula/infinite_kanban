import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSameRepo, normalizeRepoUrl, repoNameFromUrl } from '../repo-url.ts';

test('the same repository written different ways normalizes identically', () => {
  const expected = 'github.com/owner/repo';
  for (const spelling of [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo/',
    'http://github.com/owner/repo',
    'git@github.com:owner/repo.git',
    'git@github.com:owner/repo',
    'ssh://git@github.com/owner/repo.git',
    'git://github.com/owner/repo.git',
    'https://GitHub.com/owner/repo',
    '  https://github.com/owner/repo  ',
  ]) {
    assert.equal(normalizeRepoUrl(spelling), expected, spelling);
  }
});

test('normalization is idempotent: the canonical form re-normalizes to itself', () => {
  // The board sends the canonical scheme-less form on the wire, so a worker
  // normalizing a mapping key or an incoming identity again must land on the
  // same value instead of rejecting it as "not a repository".
  for (const canonical of [
    'github.com/owner/repo',
    'gitlab.com/group/subgroup/repo',
    'git.example.com:8443/owner/repo',
  ]) {
    assert.equal(normalizeRepoUrl(canonical), canonical, canonical);
    assert.equal(normalizeRepoUrl(normalizeRepoUrl(canonical)!), canonical, canonical);
  }
});

test('credentials in the URL never survive normalization', () => {
  // A remote copied from a `git remote -v` on a machine using a token must not
  // turn that token into part of the repository's identity.
  assert.equal(normalizeRepoUrl('https://user:token@github.com/owner/repo.git'), 'github.com/owner/repo');
  assert.equal(normalizeRepoUrl('ssh://git@gitlab.example.com/group/sub/repo.git'), 'gitlab.example.com/group/sub/repo');
});

test('default ports are dropped and custom ones kept', () => {
  assert.equal(normalizeRepoUrl('https://git.example.com:443/owner/repo'), 'git.example.com/owner/repo');
  assert.equal(normalizeRepoUrl('http://git.example.com:80/owner/repo'), 'git.example.com/owner/repo');
  assert.equal(normalizeRepoUrl('ssh://git@git.example.com:22/owner/repo'), 'git.example.com/owner/repo');
  assert.equal(normalizeRepoUrl('https://git.example.com:8443/owner/repo'), 'git.example.com:8443/owner/repo');
});

test('nested group paths are preserved', () => {
  assert.equal(normalizeRepoUrl('https://gitlab.com/group/subgroup/repo.git'), 'gitlab.com/group/subgroup/repo');
});

test('identity ignores case, so one repository has exactly one key', () => {
  // Both sides of the lookup (a worker's mapping, the board's project) must
  // agree regardless of how the URL was typed.
  assert.equal(normalizeRepoUrl('git@github.com:SaltyRucula/Infinite_Kanban.git'), 'github.com/saltyrucula/infinite_kanban');
  assert.equal(
    normalizeRepoUrl('https://GITHUB.com/SaltyRucula/infinite_kanban'),
    normalizeRepoUrl('git@github.com:saltyrucula/INFINITE_KANBAN.git'),
  );
});

test('unusable remotes return undefined rather than a wrong answer', () => {
  for (const bad of ['', '   ', 'not a url', 'file:///srv/repos/thing.git', 'https://github.com', 'https://github.com/']) {
    assert.equal(normalizeRepoUrl(bad), undefined, JSON.stringify(bad));
  }
});

test('repoNameFromUrl gives a directory-safe last segment', () => {
  assert.equal(repoNameFromUrl('git@github.com:owner/infinite_kanban.git'), 'infinite_kanban');
  assert.equal(repoNameFromUrl('https://gitlab.com/group/subgroup/api.git'), 'api');
  assert.equal(repoNameFromUrl('nonsense'), undefined);
});

test('isSameRepo compares identity, not spelling', () => {
  assert.equal(isSameRepo('git@github.com:owner/repo.git', 'https://github.com/owner/repo'), true);
  assert.equal(isSameRepo('https://github.com/owner/repo', 'https://github.com/owner/other'), false);
  // Two unparseable values are not "the same repository".
  assert.equal(isSameRepo('nonsense', 'nonsense'), false);
});
