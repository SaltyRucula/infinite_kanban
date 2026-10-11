import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startExecutionEndpoint } from '../src/execution-endpoint.js';
import type { ExecutionEndpointConfig } from '../src/execution-adapter.js';
import type { ExecutionAssignment, ExecutionResult } from '@ai-agent-board/shared/execution.js';

export const assignment: ExecutionAssignment = {
  schemaVersion: 1,
  taskId: 't',
  projectId: 'p',
  workflowRunId: 'r',
  assignmentId: 'a',
  attempt: 1,
  role: 'implementation',
  endpointId: 'e',
  repository: 'https://github.com/o/r',
  baseRevision: 'a'.repeat(40),
  requirements: 'Implement',
  requiredCapabilities: [],
  constraints: { deadline: Date.now() + 60000 },
};
export const result: ExecutionResult = {
  schemaVersion: 1,
  taskId: 't',
  workflowRunId: 'r',
  assignmentId: 'a',
  attempt: 1,
  role: 'implementation',
  endpointId: 'e',
  revision: 'b'.repeat(40),
  summary: 'Complete',
  evidence: [],
};
async function fixture(
  execute: (
    a: ExecutionAssignment,
    config: ExecutionEndpointConfig,
    signal: AbortSignal,
  ) => Promise<ExecutionResult>,
) {
  const stateDirectory = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'execution-blocking-'));
  const config = {
    harness: 'codex' as const,
    roles: ['implementation' as const],
    projects: ['p'],
    repositories: { 'github.com/o/r': '/not-used' },
    stateDirectory,
    capabilities: [],
    checks: [],
  };
  const endpoint = await startExecutionEndpoint(config, { execute });
  const rpc = async (method: string, params: unknown) =>
    (
      await fetch(endpoint.baseUrl + '/a2a/v1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'rpc', method, params }),
        signal: AbortSignal.timeout(3000),
      })
    ).json();
  const send = (configuration?: unknown) =>
    rpc('SendMessage', {
      message: { messageId: 'a', role: 'ROLE_USER', parts: [{ data: assignment }] },
      ...(configuration === undefined ? {} : { configuration }),
    });
  return { endpoint, config, rpc, send };
}

for (const finish of ['complete', 'fail'] as const) {
  test(`close fences in-flight noncooperative ${finish} after restart`, async () => {
    let complete!: (value: ExecutionResult) => void;
    let fail!: (error: Error) => void;
    let oldSignal!: AbortSignal;
    const f = await fixture(
      (_a, _config, signal) =>
        new Promise((resolve, reject) => {
          oldSignal = signal;
          complete = resolve;
          fail = reject;
        }),
    );
    // This harness deliberately ignores cancellation until the test releases it.
    const sent = await f.send({ returnImmediately: true });
    assert.equal(sent.result.task.status.state, 'TASK_STATE_WORKING');
    const blockedDuplicate = f.send();
    await new Promise((resolve) => setTimeout(resolve, 20));
    let timeout!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        f.endpoint.close(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('shutdown hung')), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(oldSignal.aborted, true);
    // The duplicate may race with the admission fence, but must never hang.
    const shutdownResponse = await blockedDuplicate;
    if (shutdownResponse.result) assert.equal(shutdownResponse.result.task.status.state, 'TASK_STATE_FAILED');
    else assert.equal(shutdownResponse.error.code, -32603);
    const restarted = await startExecutionEndpoint(f.config, {
      execute: async () => {
        throw new Error('must not execute twice');
      },
    });
    try {
      const get = async () =>
        (
          await (
            await fetch(restarted.baseUrl + '/a2a/v1', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 'rpc', method: 'GetTask', params: { id: 'a' } }),
            })
          ).json()
        ).result;
      assert.equal((await get()).status.state, 'TASK_STATE_FAILED');
      const before = await readFile(path.join(f.config.stateDirectory, 'execution-tasks.json'), 'utf8');
      if (finish === 'complete') complete(result);
      else fail(new Error('late failure must not write logs'));
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(
        await readFile(path.join(f.config.stateDirectory, 'execution-tasks.json'), 'utf8'),
        before,
      );
      assert.equal((await get()).status.state, 'TASK_STATE_FAILED');
      await assert.rejects(access(path.join(f.config.stateDirectory, 'a.error.log')), { code: 'ENOENT' });
    } finally {
      await restarted.close();
    }
  });
}

for (const configuration of [undefined, { returnImmediately: false }]) {
  test(`SendMessage blocks for ${JSON.stringify(configuration)} without blocking Get/Cancel/duplicates`, async () => {
    let complete!: (value: ExecutionResult) => void;
    let calls = 0;
    const f = await fixture(() => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    try {
      let settled = false;
      const waiting = f.send(configuration).then((value) => {
        settled = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(settled, false, 'blocking request returned WORKING');
      const immediate = await f.send({ returnImmediately: true });
      assert.equal(immediate.result.task.status.state, 'TASK_STATE_WORKING');
      assert.equal((await f.rpc('GetTask', { id: 'a' })).result.id, 'a');
      const duplicate = f.send({ returnImmediately: false });
      assert.equal((await f.rpc('CancelTask', { id: 'a' })).result.status.state, 'TASK_STATE_CANCELED');
      assert.equal((await waiting).result.task.status.state, 'TASK_STATE_CANCELED');
      assert.equal((await duplicate).result.task.status.state, 'TASK_STATE_CANCELED');
      assert.equal(calls, 1);
    } finally {
      complete?.(result);
      await f.endpoint.close();
    }
  });
}

test('blocking SendMessage returns completed task and immediate duplicate does not execute again', async () => {
  let complete!: (value: ExecutionResult) => void;
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  try {
    const waiting = f.send();
    await new Promise((resolve) => setTimeout(resolve, 30));
    complete(result);
    assert.equal((await waiting).result.task.status.state, 'TASK_STATE_COMPLETED');
  } finally {
    await f.endpoint.close();
  }
});

test('a blocking assignment does not lock admission of another assignment', async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return new Promise<ExecutionResult>(() => {});
  });
  try {
    const first = f.send();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await f.rpc('SendMessage', {
      configuration: { returnImmediately: true },
      message: {
        messageId: 'second',
        role: 'ROLE_USER',
        parts: [{ data: { ...assignment, assignmentId: 'second' } }],
      },
    });
    assert.equal(second.result.task.status.state, 'TASK_STATE_WORKING');
    assert.equal(calls, 2);
    await f.rpc('CancelTask', { id: 'a' });
    assert.equal((await first).result.task.status.state, 'TASK_STATE_CANCELED');
  } finally {
    await f.endpoint.close();
  }
});

test('malformed configuration and structured parts are refused before execution', async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return result;
  });
  try {
    for (const configuration of [null, [], 'bad', { returnImmediately: 'false' }]) {
      assert.equal((await f.send(configuration)).error.code, -32602);
    }
    for (const parts of [{}, [null], 'bad']) {
      const response = await f.rpc('SendMessage', { message: { messageId: 'a', role: 'ROLE_USER', parts } });
      assert.equal(response.error.code, -32602);
    }
    assert.equal(calls, 0);
  } finally {
    await f.endpoint.close();
  }
});
