import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import * as workflowClient from '../src/services/a2a-workflow-client.js';

const { createA2AMessageSendParams } = workflowClient;

// JSON-RPC transport belongs in the A2A boundary, not the board workflow mapper.
test('exports a JSON-RPC A2A executor', () => {
  assert.equal(typeof (workflowClient as Record<string, unknown>).JsonRpcA2AExecutor, 'function');
});
import type { WorkflowTicket } from '../src/services/workflow-policy.js';

function ticket(overrides: Partial<WorkflowTicket> = {}): WorkflowTicket {
  return {
    id: 'ticket-1',
    projectId: 'project-1',
    phase: 'rework_requested',
    reviewRound: 1,
    reviewFeedback: 'Add coverage for cancellation.',
    runs: [],
    ...overrides,
  };
}

test('creates an A2A implementation message with ticket context and review feedback', () => {
  const params = createA2AMessageSendParams(ticket(), {
    type: 'dispatch',
    role: 'implementation',
    agentId: 'implementer-1',
    reviewRound: 1,
    reviewFeedback: 'Add coverage for cancellation.',
  }, 'message-1');

  assert.deepEqual(params, {
    message: {
      role: 'ROLE_USER',
      messageId: 'message-1',
      parts: [{
        kind: 'text',
        text: 'Continue implementation for board ticket ticket-1.\n\nReview feedback:\nAdd coverage for cancellation.',
      }],
    },
    metadata: {
      'infinite_kanban.ticket_id': 'ticket-1',
      'infinite_kanban.project_id': 'project-1',
      'infinite_kanban.workflow_role': 'implementation',
      'infinite_kanban.review_round': 1,
    },
  });
});

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.once('end', () => resolve(body));
    request.once('error', reject);
  });
}

function respond(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

test('dispatches, polls, retries and cancels through a secret-free JSON-RPC boundary', async () => {
  const requests: Array<{ headers: IncomingMessage['headers']; body: string }> = [];
  let sendAttempts = 0;
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ headers: request.headers, body });
    const payload = JSON.parse(body) as { id: string; method: string; params: Record<string, unknown> };

    if (payload.method === 'message/send') {
      sendAttempts += 1;
      if (sendAttempts === 1) return respond(response, { error: 'retry' }, 503);
      return respond(response, {
        jsonrpc: '2.0', id: payload.id,
        result: { id: 'remote-task-1', status: { state: 'working' } },
      });
    }
    if (payload.method === 'tasks/get') {
      return respond(response, {
        jsonrpc: '2.0', id: payload.id,
        result: {
          id: 'remote-task-1',
          status: { state: 'completed' },
          artifacts: [{ name: 'pull-request', parts: [{ text: 'https://example.test/pr/1' }] }],
        },
      });
    }
    if (payload.method === 'tasks/cancel') {
      return respond(response, {
        jsonrpc: '2.0', id: payload.id,
        result: { id: 'remote-task-1', status: { state: 'canceled' } },
      });
    }
    return respond(response, { jsonrpc: '2.0', id: payload.id, error: { code: -32601, message: 'Unknown method' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  try {
    const Executor = workflowClient.JsonRpcA2AExecutor as unknown as new (endpoint: string, options?: { maxRetries?: number }) => {
      dispatch(params: workflowClient.A2AMessageSendParams): Promise<{ remoteTaskId: string }>;
      getUpdate(remoteTaskId: string): Promise<{ state: string; artifacts: readonly unknown[] }>;
      cancel(remoteTaskId: string): Promise<void>;
    };
    const executor = new Executor(`http://127.0.0.1:${address.port}/a2a`, { maxRetries: 1 });
    assert.equal(typeof executor.dispatch, 'function');

    const params = createA2AMessageSendParams(ticket(), {
      type: 'dispatch', role: 'implementation', agentId: 'agent-1', reviewRound: 1,
    }, 'stable-message-1');
    assert.deepEqual(await executor.dispatch(params), { remoteTaskId: 'remote-task-1' });
    assert.deepEqual(await executor.getUpdate('remote-task-1'), {
      state: 'completed',
      artifacts: [{ name: 'pull-request', parts: [{ text: 'https://example.test/pr/1' }] }],
    });
    await executor.cancel('remote-task-1');

    assert.equal(requests.length, 4);
    assert.equal(requests[0].body, requests[1].body);
    const send = JSON.parse(requests[0].body) as { jsonrpc: string; id: string; method: string; params: unknown };
    assert.deepEqual(send, { jsonrpc: '2.0', id: 'stable-message-1', method: 'message/send', params });
    assert.equal(JSON.parse(requests[2].body).method, 'tasks/get');
    assert.equal(JSON.parse(requests[3].body).method, 'tasks/cancel');
    for (const request of requests) {
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
    }
  } finally {
    await closeServer(server);
  }
});

test('preserves JSON-RPC errors and rejects malformed task responses', async () => {
  const Executor = workflowClient.JsonRpcA2AExecutor as unknown as new (endpoint: string, options: { fetcher: workflowClient.A2AFetch }) => {
    dispatch(params: workflowClient.A2AMessageSendParams): Promise<unknown>;
  };
  const params = createA2AMessageSendParams(ticket(), {
    type: 'dispatch', role: 'implementation', agentId: 'agent-1', reviewRound: 1,
  }, 'stable-message-2');

  const rpcErrorExecutor = new Executor('https://agent.example.test/a2a', {
    fetcher: async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 'stable-message-2', error: { code: -32001, message: 'Agent unavailable', data: { retryAfter: 30 } },
    }), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    rpcErrorExecutor.dispatch(params),
    (error: unknown) => error instanceof workflowClient.A2AExecutorError
      && error.code === 'protocol'
      && error.rpcCode === -32001
      && (error.rpcData as { retryAfter?: number }).retryAfter === 30,
  );

  const malformedExecutor = new Executor('https://agent.example.test/a2a', {
    fetcher: async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 'stable-message-2', result: { id: 'remote-task-2', status: 'completed' },
    }), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    malformedExecutor.dispatch(params),
    (error: unknown) => error instanceof workflowClient.A2AExecutorError && error.code === 'protocol',
  );
});
