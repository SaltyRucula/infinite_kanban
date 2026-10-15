import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLlmDemoMission,
  parseArguments,
  runnerInvocation,
} from './llm-local-demo.mjs';

test('uses Hermes and OpenCode as the safe local-demo defaults', () => {
  assert.deepEqual(parseArguments([]), {
    boardUrl: undefined,
    dryRun: false,
    harness: 'opencode',
    printPrompt: false,
    runner: 'hermes',
  });
});

test('accepts an explicit runner, harness, and board URL', () => {
  assert.deepEqual(parseArguments([
    '--runner', '/opt/bin/hermes',
    '--harness', 'codex',
    '--board', 'http://127.0.0.1:8080',
  ]), {
    boardUrl: 'http://127.0.0.1:8080',
    dryRun: false,
    harness: 'codex',
    printPrompt: false,
    runner: '/opt/bin/hermes',
  });
});

test('rejects unsupported values instead of passing shell-like arguments through', () => {
  assert.throws(() => parseArguments(['--runner', 'hermes chat']), /single executable/);
  assert.throws(() => parseArguments(['--harness', 'claude']), /Unsupported harness/);
  assert.throws(() => parseArguments(['--unknown']), /Unknown option/);
});

test('creates a bounded mission that preserves secrets and runs the deterministic demo', () => {
  const mission = buildLlmDemoMission({
    repoRoot: '/workspace/infinite_kanban',
    harness: 'codex',
    boardUrl: 'http://127.0.0.1:8080',
  });

  assert.match(mission, /Never print, read, copy, or request secrets/);
  assert.match(mission, /Do not use sudo or a system package manager/);
  assert.match(mission, /npm ci --include=dev/);
  assert.match(mission, /DEMO_IMPLEMENTATION_HARNESS=codex/);
  assert.match(mission, /DEMO_REVIEW_HARNESS=codex/);
  assert.match(mission, /node scripts\/demo-board-a2a\.mjs http:\/\/127\.0\.0\.1:8080/);
});

test('starts the selected runner through argv, not a shell command', () => {
  assert.deepEqual(runnerInvocation('/opt/bin/hermes', 'mission'), {
    command: '/opt/bin/hermes',
    args: ['chat', '-q', 'mission'],
  });
});
