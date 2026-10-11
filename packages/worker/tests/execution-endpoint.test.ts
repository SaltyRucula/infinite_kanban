import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startExecutionEndpoint } from '../src/execution-endpoint.js';
const assignment: any = {
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
test('native A2A endpoint durably correlates duplicate SendMessage and refuses consent without harness execution', async () => {
  const stateDirectory = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'a2a-endpoint-'));
  let calls = 0;
  const config: any = {
    harness: 'codex',
    roles: ['implementation'],
    projects: ['p'],
    repositories: { 'github.com/o/r': '/not-used' },
    stateDirectory,
    capabilities: [],
    checks: [],
  };
  const execute = async (a: any) => {
    calls++;
    return {
      schemaVersion: 1,
      taskId: a.taskId,
      workflowRunId: a.workflowRunId,
      assignmentId: a.assignmentId,
      attempt: a.attempt,
      role: a.role,
      endpointId: a.endpointId,
      revision: 'b'.repeat(40),
      summary: 'real boundary test',
      evidence: [],
    };
  };
  let endpoint = await startExecutionEndpoint(config, { port: 0, execute });
  const rpc = async (method: string, params: any) => {
    return (
      await (
        await fetch(endpoint.baseUrl + '/a2a/v1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'rpc', method, params }),
        })
      ).json()
    ).result;
  };
  const params = { message: { messageId: 'a', role: 'ROLE_USER', parts: [{ data: assignment }] } };
  try {
    const sent = await rpc('SendMessage', params);
    assert.equal(sent.task.id, 'a');
    await rpc('SendMessage', params);
    assert.equal(calls, 1);
    assert.equal((await rpc('GetTask', { id: 'a' })).id, 'a');
    await endpoint.close();
    endpoint = await startExecutionEndpoint(config, { port: 0, execute });
    await rpc('SendMessage', params);
    assert.equal(calls, 1);
    const refused = await rpc('SendMessage', {
      message: {
        messageId: 'refused',
        role: 'ROLE_USER',
        parts: [{ data: { ...assignment, assignmentId: 'refused', projectId: 'other' } }],
      },
    });
    assert.equal(refused.task.status.state, 'TASK_STATE_REJECTED');
    assert.equal(calls, 1, 'refusal must not call the harness');
    await endpoint.close();
    endpoint = await startExecutionEndpoint(config, {
      port: 0,
      execute: async () => {
        throw new Error('deliberate harness failure');
      },
    });
    await rpc('SendMessage', {
      message: {
        messageId: 'failed',
        role: 'ROLE_USER',
        parts: [{ data: { ...assignment, assignmentId: 'failed' } }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await rpc('GetTask', { id: 'failed' })).status.state, 'TASK_STATE_FAILED');
    const { readFile } = await import('node:fs/promises');
    assert.match(
      await readFile(path.join(stateDirectory, 'failed.error.log'), 'utf8'),
      /deliberate harness failure/,
    );
  } finally {
    await endpoint.close();
  }
});
