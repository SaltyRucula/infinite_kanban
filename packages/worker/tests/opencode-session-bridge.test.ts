import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenCodeSessionBridge, buildOpenCodeUiSessionUrl } from '../src/opencode-session-bridge.js';

test('buildOpenCodeUiSessionUrl generates the exact encoded directory session route', () => {
  const url = buildOpenCodeUiSessionUrl('http://127.0.0.1:4096', '/Users/example/project', 'session-1');
  assert.equal(url, 'http://127.0.0.1:4096/L1VzZXJzL2V4YW1wbGUvcHJvamVjdA/session/session-1');
});

test('OpenCodeSessionBridge redirects task session links to local OpenCode UI route', async () => {
  const bridge = await OpenCodeSessionBridge.start();
  try {
    const bridgeUrl = bridge.register({
      taskId: 'task-1',
      sessionId: 'ses_worker_1',
      workspacePath: '/Users/example/project',
      baseUrl: 'http://127.0.0.1:4096',
    });

    const response = await fetch(bridgeUrl, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('location'),
      'http://127.0.0.1:4096/L1VzZXJzL2V4YW1wbGUvcHJvamVjdA/session/ses_worker_1',
    );
  } finally {
    await bridge.close();
  }
});

test('OpenCodeSessionBridge rejects invalid and unknown task links', async () => {
  const bridge = await OpenCodeSessionBridge.start();
  try {
    bridge.register({
      taskId: 'task-1',
      sessionId: 'ses_worker_1',
      workspacePath: '/Users/example/project',
      baseUrl: 'http://127.0.0.1:4096',
    });

    const invalidTask = await fetch(`http://127.0.0.1:${bridge.port}/session/%2Fbad`, { redirect: 'manual' });
    assert.equal(invalidTask.status, 400);

    const unknownTask = await fetch(`http://127.0.0.1:${bridge.port}/session/task-unknown`, { redirect: 'manual' });
    assert.equal(unknownTask.status, 404);
  } finally {
    await bridge.close();
  }
});

test('OpenCodeSessionBridge unregister removes completed task mapping while bridge stays active', async () => {
  const bridge = await OpenCodeSessionBridge.start();
  try {
    const url = bridge.register({
      taskId: 'task-1',
      sessionId: 'ses_worker_1',
      workspacePath: '/Users/example/project',
      baseUrl: 'http://127.0.0.1:4096',
    });
    bridge.unregister('task-1');

    const afterCleanup = await fetch(url, { redirect: 'manual' });
    assert.equal(afterCleanup.status, 404);

    const nextUrl = bridge.register({
      taskId: 'task-2',
      sessionId: 'ses_worker_2',
      workspacePath: '/Users/example/project',
      baseUrl: 'http://127.0.0.1:4096',
    });
    const nextResponse = await fetch(nextUrl, { redirect: 'manual' });
    assert.equal(nextResponse.status, 302);
  } finally {
    await bridge.close();
  }
});

test('OpenCodeSessionBridge binds only loopback and emits loopback bridge URLs', async () => {
  const bridge = await OpenCodeSessionBridge.start({ port: 0 });
  try {
    const url = bridge.register({
      taskId: 'task-loopback',
      sessionId: 'ses_worker_1',
      workspacePath: '/Users/example/project',
      baseUrl: 'http://127.0.0.1:4096',
    });

    assert.equal(bridge.host, '127.0.0.1');
    assert.equal(url.startsWith(`http://127.0.0.1:${bridge.port}/session/task-loopback`), true);
  } finally {
    await bridge.close();
  }
});
