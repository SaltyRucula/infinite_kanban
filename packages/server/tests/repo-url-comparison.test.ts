import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeRepoUrl } from '../src/routes/helpers.js';

test('the SSH and HTTPS spellings of one repository compare equal', () => {
  // This comparison decides whether a project's declared repoUrl matches the
  // checkout's actual `origin`. People write one as SSH and the other as
  // HTTPS constantly, and a textual compare calls them different repositories.
  const expected = 'github.com/owner/repo';
  for (const spelling of [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo/',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'https://GitHub.com/Owner/Repo.git',
    '  https://github.com/owner/repo  ',
  ]) {
    assert.equal(normalizeRepoUrl(spelling), expected, spelling);
  }
});

test('credentials in a remote do not change its identity', () => {
  // A token pasted into a remote must not make the same repository look like a
  // different one (nor leak into a comparison key).
  assert.equal(normalizeRepoUrl('https://user@github.com/owner/repo.git'), 'github.com/owner/repo');
});

test('distinct repositories still differ', () => {
  assert.notEqual(normalizeRepoUrl('https://github.com/owner/repo'), normalizeRepoUrl('https://github.com/owner/other'));
  assert.notEqual(normalizeRepoUrl('https://github.com/owner/repo'), normalizeRepoUrl('https://gitlab.com/owner/repo'));
});

test('a non-default port is part of the identity', () => {
  // Two self-hosted servers can share a host and differ only by port.
  assert.notEqual(
    normalizeRepoUrl('https://git.example.com:8443/owner/repo'),
    normalizeRepoUrl('https://git.example.com/owner/repo'),
  );
  assert.equal(normalizeRepoUrl('https://git.example.com:8443/owner/repo'), 'git.example.com:8443/owner/repo');
});

test('unrecognisable values keep the previous textual cleanup', () => {
  // They must not all collapse onto one key, which would make unrelated
  // values compare equal.
  assert.equal(normalizeRepoUrl('/srv/repos/thing.git'), '/srv/repos/thing');
  assert.equal(normalizeRepoUrl('Not A Remote/'), 'not a remote');
  assert.notEqual(normalizeRepoUrl('/srv/repos/a'), normalizeRepoUrl('/srv/repos/b'));
});
