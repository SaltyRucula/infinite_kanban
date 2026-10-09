import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWorkspaceSettings, resolveRepository } from '../src/local-runner.ts';

const base = { workspacePath: '/home/dev/work', runner: { kind: 'agent-sdk' as const } };

test('a repos mapping is normalized on load so spellings still match', () => {
  const settings = parseWorkspaceSettings({
    ...base,
    repos: {
      // written the way `git remote -v` prints it
      'git@github.com:owner/infra.git': '/home/dev/repos/infra',
      'https://github.com/owner/app': '/home/dev/repos/app',
    },
  });
  assert.deepEqual(settings.repos, {
    'github.com/owner/infra': '/home/dev/repos/infra',
    'github.com/owner/app': '/home/dev/repos/app',
  });
});

test('unusable mapping entries are dropped without killing the worker', () => {
  // One bad line in a hand-edited config should cost that repository, not the
  // machine's ability to run any task at all.
  const settings = parseWorkspaceSettings({
    ...base,
    repos: {
      'not a url': '/home/dev/repos/nope',
      'https://github.com/owner/app': '   ',
      'https://github.com/owner/good': '/home/dev/repos/good',
    },
  });
  assert.deepEqual(settings.repos, { 'github.com/owner/good': '/home/dev/repos/good' });
});

test('an absent or empty repos block leaves settings without one', () => {
  assert.equal(parseWorkspaceSettings(base).repos, undefined);
  assert.equal(parseWorkspaceSettings({ ...base, repos: {} }).repos, undefined);
  assert.equal(parseWorkspaceSettings({ ...base, repos: 'nonsense' }).repos, undefined);
});

test('repos survives every runner shape', () => {
  const repos = { 'https://github.com/owner/app': '/repos/app' };
  const expected = { 'github.com/owner/app': '/repos/app' };
  assert.deepEqual(parseWorkspaceSettings({ workspacePath: '/w', repos }).repos, expected);
  assert.deepEqual(parseWorkspaceSettings({ workspacePath: '/w', runner: { kind: 'agent-sdk' }, repos }).repos, expected);
  assert.deepEqual(
    parseWorkspaceSettings({ workspacePath: '/w', runner: { kind: 'opencode-server', agent: 'build' }, repos }).repos,
    expected,
  );
});

test('a mapped repository resolves to its checkout whatever spelling the board sends', () => {
  const settings = { repos: { 'github.com/owner/infra': '/home/dev/repos/infra' } };
  for (const url of [
    'github.com/owner/infra',
    'https://github.com/owner/infra',
    'git@github.com:owner/infra.git',
    'https://github.com/owner/infra.git',
  ]) {
    assert.deepEqual(
      resolveRepository(settings, { url }),
      { kind: 'resolved', directory: '/home/dev/repos/infra', repoUrl: 'github.com/owner/infra' },
      url,
    );
  }
});

test('an unknown repository is reported as unmapped, never silently run elsewhere', () => {
  // The caller refuses the task on this result. Falling back to the workspace
  // root here is how edits land in the wrong repository.
  const settings = { repos: { 'github.com/owner/infra': '/home/dev/repos/infra' } };
  assert.deepEqual(
    resolveRepository(settings, { url: 'https://github.com/owner/app' }),
    { kind: 'unmapped', repoUrl: 'github.com/owner/app' },
  );
  assert.deepEqual(
    resolveRepository({}, { url: 'https://github.com/owner/app' }),
    { kind: 'unmapped', repoUrl: 'github.com/owner/app' },
  );
});

test('no repository identity keeps the previous workspace-root behaviour', () => {
  const settings = { repos: { 'github.com/owner/infra': '/home/dev/repos/infra' } };
  assert.deepEqual(resolveRepository(settings, undefined), { kind: 'none' });
  assert.deepEqual(resolveRepository(settings, {}), { kind: 'none' });
  // An unparseable remote is treated as "no identity" rather than as a
  // mismatch, so a malformed project remote cannot block every task.
  assert.deepEqual(resolveRepository(settings, { url: 'not a url' }), { kind: 'none' });
});
