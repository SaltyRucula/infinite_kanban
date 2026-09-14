import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import {
  parseWorkspaceSettings,
  runOpenCodeTask,
  type OpenCodeProcess,
  type OpenCodeSpawn,
} from '../src/local-runner.js';

const task: WorkerTaskAssignment = {
  id: 'task-1',
  title: 'Implement local runner seam',
  description: 'Wire worker to opencode run with a local profile',
  priority: 'high',
  labels: ['orioninit', 'worker-local'],
  agentType: 'opencode',
};

class FakeOpenCodeProcess extends EventEmitter implements OpenCodeProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killCalled = false;

  kill(): boolean {
    this.killCalled = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', null, 'SIGTERM');
    return true;
  }
}

test('parseWorkspaceSettings defaults to agent-sdk for legacy workspace-only config', () => {
  const parsed = parseWorkspaceSettings({ workspacePath: '/tmp/workspace' });
  assert.deepEqual(parsed, {
    workspacePath: '/tmp/workspace',
    runner: { kind: 'agent-sdk' },
  });
});

test('parseWorkspaceSettings rejects opencode-run runner without agent', () => {
  assert.throws(
    () => parseWorkspaceSettings({ workspacePath: '/tmp/workspace', runner: { kind: 'opencode-run' } }),
    /runner.agent must be a non-empty string when runner.kind is opencode-run/,
  );
});

test('runOpenCodeTask spawns opencode run with exact argv, shell:false, and labels in the prompt', async () => {
  const spawned = new FakeOpenCodeProcess();
  let command = '';
  let argv: readonly string[] = [];
  let shellOption: string | boolean | undefined;
  const order: string[] = [];

  const spawnFn: OpenCodeSpawn = (nextCommand, nextArgs, options) => {
    order.push('spawn');
    command = nextCommand;
    argv = nextArgs;
    shellOption = options.shell;
    queueMicrotask(() => {
      spawned.stdout.end();
      spawned.stderr.end();
      spawned.emit('close', 0, null);
    });
    return spawned;
  };

  const result = await runOpenCodeTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-run', agent: 'sisyphus' },
    sendEvent: async (event) => {
      order.push(`sendEvent:${event.type}`);
      assert.equal(event.type, 'thinking');
      assert.equal(event.content, 'Starting local Sisyphus runner…');
    },
    spawnFn,
  });

  assert.deepEqual(order, ['sendEvent:thinking', 'spawn']);
  assert.equal(command, 'opencode');
  assert.deepEqual(argv, [
    'run',
    '--agent',
    'sisyphus',
    '--format',
    'json',
    '--dir',
    '/tmp/workspace',
    [
      'Task title: Implement local runner seam',
      '',
      'Task description: Wire worker to opencode run with a local profile',
      '',
      'Labels: orioninit, worker-local',
    ].join('\n'),
  ]);
  assert.equal(shellOption, false);
  assert.equal(result.status, 'complete');
});

test('runOpenCodeTask continues when the immediate start event upload fails', async () => {
  const spawned = new FakeOpenCodeProcess();
  let spawnCount = 0;

  const spawnFn: OpenCodeSpawn = () => {
    spawnCount += 1;
    queueMicrotask(() => {
      spawned.stdout.end();
      spawned.stderr.end();
      spawned.emit('close', 0, null);
    });
    return spawned;
  };

  const result = await runOpenCodeTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-run', agent: 'sisyphus' },
    sendEvent: async () => {
      throw new Error('event upload failed');
    },
    spawnFn,
  });

  assert.equal(spawnCount, 1);
  assert.equal(result.status, 'complete');
});

test('runOpenCodeTask maps JSONL output to worker AgentEvents safely', async () => {
  const spawned = new FakeOpenCodeProcess();
  const events: { type: string; content: string }[] = [];

  const spawnFn: OpenCodeSpawn = () => {
    queueMicrotask(() => {
      spawned.stdout.write('{"id":"evt-1","type":"thinking","content":"Working in /tmp/workspace"}\n');
      spawned.stdout.write('{"type":"something-new","message":"raw json fallback"}\n');
      spawned.stdout.write('not json\n');
      spawned.stdout.end();
      spawned.stderr.end();
      spawned.emit('close', 0, null);
    });
    return spawned;
  };

  await runOpenCodeTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-run', agent: 'sisyphus' },
    sendEvent: async (event) => {
      if (event.content === 'Starting local Sisyphus runner…') {
        return;
      }
      events.push({ type: event.type, content: event.content });
    },
    spawnFn,
  });

  assert.deepEqual(events.map((event) => event.type), ['thinking', 'output', 'output']);
  assert.match(events[0]?.content ?? '', /\[local workspace\]/);
  assert.match(events[2]?.content ?? '', /not json/);
});

test('runOpenCodeTask handles spawned-process errors and strips workspace paths', async () => {
  const spawned = new FakeOpenCodeProcess();
  const spawnFn: OpenCodeSpawn = () => {
    queueMicrotask(() => {
      spawned.emit('error', new Error('spawn failed in /tmp/workspace'));
    });
    return spawned;
  };

  const result = await runOpenCodeTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-run', agent: 'sisyphus' },
    sendEvent: async () => {},
    spawnFn,
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /\[local workspace\]/);
});

test('runOpenCodeTask handles cancellation by terminating child process', async () => {
  const spawned = new FakeOpenCodeProcess();
  const controller = new AbortController();
  const spawnFn: OpenCodeSpawn = () => spawned;

  const resultPromise = runOpenCodeTask({
    task,
    workspacePath: '/tmp/workspace',
    runner: { kind: 'opencode-run', agent: 'sisyphus' },
    sendEvent: async () => {},
    spawnFn,
    abortSignal: controller.signal,
  });
  controller.abort();

  const result = await resultPromise;
  assert.equal(spawned.killCalled, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'local runner cancelled');
});
