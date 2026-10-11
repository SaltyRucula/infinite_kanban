import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startExecutionEndpoint } from '../src/execution-endpoint.js';
import type { ExecutionEndpointConfig } from '../src/execution-types.js';
import type { ExecutionAssignment, ExecutionResult } from '@ai-agent-board/shared/execution.js';

const revision = 'a'.repeat(40);

async function fixture(): Promise<ExecutionEndpointConfig> {
  return {
    harness: 'opencode',
    roles: ['implementation'],
    projects: ['p'],
    repositories: { 'https://github.com/o/r': '/tmp/none' },
    stateDirectory: await mkdtemp(path.join(tmpdir(), 'progress-')),
    capabilities: [],
    checks: [],
  };
}

function assignment(): ExecutionAssignment {
  return {
    schemaVersion: 1, taskId: 't', projectId: 'p', workflowRunId: 'w',
    assignmentId: 'assignment-1', attempt: 1, role: 'implementation', endpointId: 'e',
    repository: 'https://github.com/o/r', baseRevision: revision,
    requirements: 'do it', requiredCapabilities: [], constraints: { deadline: Date.now() + 60_000 },
  };
}

async function rpc(baseUrl: string, method: string, params: unknown): Promise<{ result?: { task?: unknown } & Record<string, unknown>; error?: unknown }> {
  const response = await fetch(`${baseUrl}/a2a/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  return response.json() as Promise<{ result?: { task?: unknown } & Record<string, unknown>; error?: unknown }>;
}

/**
 * Without progress the board shows nothing between dispatch and completion, so
 * a two-minute run is indistinguishable from a hung one. Progress travels as
 * ordinary A2A history messages, which any conforming client can read.
 */
test('harness progress is exposed as task history while the run is still going', async () => {
  const config = await fixture();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const endpoint = await startExecutionEndpoint(config, {
    port: 0,
    execute: async (a, _config, _signal, onProgress) => {
      onProgress?.({ type: 'thinking', content: 'reading add.cjs' });
      onProgress?.({ type: 'command', content: 'node --test' });
      await gate;
      return {
        schemaVersion: 1, taskId: a.taskId, workflowRunId: a.workflowRunId, assignmentId: a.assignmentId,
        attempt: a.attempt, role: a.role, endpointId: a.endpointId, revision, summary: 'done',
        evidence: [{ check: 'c', revision, outcome: 'passed', artifact: `urn:sha256:${'c'.repeat(64)}` }],
      } satisfies ExecutionResult;
    },
  });
  try {
    await rpc(endpoint.baseUrl, 'SendMessage', {
      message: { messageId: 'assignment-1', role: 'ROLE_USER', parts: [{ data: assignment() }] },
      configuration: { returnImmediately: true },
    });
    // Poll like the board does: progress must be visible before the result.
    let history: { role: string; parts: { text: string }[] }[] = [];
    for (let attempt = 0; attempt < 50 && history.length < 2; attempt += 1) {
      const update = await rpc(endpoint.baseUrl, 'GetTask', { id: 'assignment-1' });
      history = ((update.result as { history?: typeof history })?.history) ?? [];
      if (history.length < 2) await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    assert.equal(history.length, 2, JSON.stringify(history));
    assert.deepEqual(history.map((message) => message.parts[0].text), ['reading add.cjs', 'node --test']);
    assert.ok(history.every((message) => message.role === 'ROLE_AGENT'));
    release();
  } finally {
    release();
    await endpoint.close();
  }
});

test('progress history is bounded so a chatty harness cannot grow the task without limit', async () => {
  const config = await fixture();
  const endpoint = await startExecutionEndpoint(config, {
    port: 0,
    execute: async (a, _config, _signal, onProgress) => {
      for (let i = 0; i < 500; i += 1) onProgress?.({ type: 'output', content: `line ${i}` });
      return {
        schemaVersion: 1, taskId: a.taskId, workflowRunId: a.workflowRunId, assignmentId: a.assignmentId,
        attempt: a.attempt, role: a.role, endpointId: a.endpointId, revision, summary: 'done',
        evidence: [{ check: 'c', revision, outcome: 'passed', artifact: `urn:sha256:${'c'.repeat(64)}` }],
      } satisfies ExecutionResult;
    },
  });
  try {
    await rpc(endpoint.baseUrl, 'SendMessage', {
      message: { messageId: 'assignment-1', role: 'ROLE_USER', parts: [{ data: assignment() }] },
      configuration: { returnImmediately: true },
    });
    let history: unknown[] = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const update = await rpc(endpoint.baseUrl, 'GetTask', { id: 'assignment-1' });
      const task = update.result as { status?: { state?: string }; history?: unknown[] };
      history = task.history ?? [];
      if (task.status?.state === 'TASK_STATE_COMPLETED') break;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    assert.ok(history.length <= 200, `history grew to ${history.length}`);
    // The newest activity is what an operator needs; the oldest is dropped.
    const last = history.at(-1) as { parts: { text: string }[] };
    assert.equal(last.parts[0].text, 'line 499');
  } finally {
    await endpoint.close();
  }
});
