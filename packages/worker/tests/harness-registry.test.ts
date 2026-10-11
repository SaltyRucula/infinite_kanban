import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HARNESS_REGISTRY,
  harnessNames,
  resolveHarness,
  readOnlyDenial,
  type HarnessName,
} from '../src/harness-registry.js';

test('every advertised harness declares whether it can enforce a read-only review', () => {
  assert.ok(harnessNames().length >= 6, harnessNames().join(','));
  for (const name of harnessNames()) {
    const entry = HARNESS_REGISTRY[name];
    assert.equal(typeof entry.readOnlyReview, 'boolean', name);
    // A harness that cannot enforce read-only must say why, in words an operator
    // can act on; this string is surfaced when an assignment is refused.
    if (!entry.readOnlyReview) {
      const reason = entry.reason ?? '';
      assert.ok(reason.length >= 25 && reason.includes(' '), `${name} needs an explanatory reason, got: ${reason}`);
    }
    assert.equal(typeof entry.create, 'function', name);
  }
});

test('read-only enforcement is claimed only where the provider actually implements it', () => {
  // OpenCode v2 tool denies, the Codex sandbox, Copilot permission denies and the
  // ACP permission flow are real mechanisms. Claude is driven through a provider
  // that ignores permission hooks here, so it must not claim review.
  for (const name of ['opencode', 'codex', 'hermes', 'openclaw'] as HarnessName[]) {
    assert.equal(HARNESS_REGISTRY[name].readOnlyReview, true, name);
  }
  // Observed, not assumed: Copilot reads through the shell, so denying shell
  // leaves it unable to inspect the revision; Claude ignores permission hooks.
  assert.equal(HARNESS_REGISTRY.copilot.readOnlyReview, false);
  assert.equal(HARNESS_REGISTRY.claude.readOnlyReview, false);
});

test('resolveHarness rejects an unknown name and lists what is supported', () => {
  assert.throws(() => resolveHarness('gpt5'), (error: Error) => {
    assert.match(error.message, /gpt5/);
    for (const name of harnessNames()) assert.match(error.message, new RegExp(name));
    return true;
  });
});

test('a harness that cannot enforce read-only is refused the review role, not silently downgraded', () => {
  assert.match(readOnlyDenial('claude') ?? '', /claude/);
  assert.match(readOnlyDenial('claude') ?? '', /review/i);
  assert.match(readOnlyDenial('copilot') ?? '', /shell/);
  for (const name of ['opencode', 'codex', 'hermes'] as HarnessName[]) {
    assert.equal(readOnlyDenial(name), undefined, name);
  }
});

test('resolveHarness returns a callable harness for every registered name', () => {
  for (const name of harnessNames()) {
    assert.equal(typeof resolveHarness(name)({ harness: name, roles: ['implementation'], projects: ['p'], repositories: {}, stateDirectory: '/tmp/x', capabilities: [], checks: [] }), 'function', name);
  }
});
