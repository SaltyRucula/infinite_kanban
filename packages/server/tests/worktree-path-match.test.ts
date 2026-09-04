import assert from 'node:assert/strict';
import test from 'node:test';
import { worktreePathsMatch } from '../src/services/agent-manager.js';

test('worktreePathsMatch treats macOS /var and /private/var as the same worktree', () => {
  // Given: git reports the canonical /private/var path while the stored path is /var
  const canonicalize = (p: string): string =>
    p.startsWith('/var/') ? `/private${p}` : p;

  // When/Then: the symlinked pair matches after canonicalization
  assert.equal(
    worktreePathsMatch(
      '/private/var/folders/x/agentboard-abc-SMYr1P',
      '/var/folders/x/agentboard-abc-SMYr1P',
      canonicalize,
    ),
    true,
  );

  // And: distinct worktrees still do not match
  assert.equal(
    worktreePathsMatch(
      '/private/var/folders/x/agentboard-abc-SMYr1P',
      '/var/folders/x/agentboard-abc-Sjt4WY',
      canonicalize,
    ),
    false,
  );
});

test('worktreePathsMatch falls back to raw comparison when canonicalization throws', () => {
  // Given: a canonicalizer that throws (e.g. the path no longer exists)
  const canonicalize = (): string => {
    throw new Error('ENOENT');
  };

  // When/Then: identical raw paths still match, differing ones do not
  assert.equal(worktreePathsMatch('/tmp/a', '/tmp/a/', canonicalize), true);
  assert.equal(worktreePathsMatch('/tmp/a', '/tmp/b', canonicalize), false);
});
