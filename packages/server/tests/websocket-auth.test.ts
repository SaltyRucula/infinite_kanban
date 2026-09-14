import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';

type UpgradeOutcome =
  | { readonly kind: 'upgrade'; readonly statusCode: 101 }
  | { readonly kind: 'rejection'; readonly statusCode: number };

async function load() {
  return import(`../src/websocket.js?test=${Date.now()}-${Math.random()}`);
}

async function withServer(callback: (server: import('node:http').Server, baseUrl: string) => Promise<UpgradeOutcome>): Promise<UpgradeOutcome> {
  const { createServer } = await import('node:http');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    return await callback(server, `http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function connect(token?: string): Promise<UpgradeOutcome> {
  const { createWSS } = await load();
  return withServer(async (server, serverUrl) => {
    const wss = createWSS(server);
    const url = new URL('/ws', serverUrl);
    if (token) url.searchParams.set('token', token);

    try {
      return await new Promise<UpgradeOutcome>((resolve, reject) => {
      const socket = new WebSocket(url);
        socket.once('open', () => {
          socket.close();
          resolve({ kind: 'upgrade', statusCode: 101 });
        });
        socket.once('unexpected-response', (_request, response) => {
          response.resume();
          resolve({ kind: 'rejection', statusCode: response.statusCode ?? 0 });
        });
        socket.once('error', reject);
      });
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
}

test('allows browser websocket upgrade without a token when API_KEY is unset even with service tokens', async () => {
  delete process.env.API_KEY;
  process.env.SERVICE_TOKENS = JSON.stringify([{ token: 'service-secret', scopes: ['projects:read'] }]);
  const outcome = await connect();
  assert.equal(outcome.kind, 'upgrade');
  assert.equal(outcome.statusCode, 101);
  delete process.env.SERVICE_TOKENS;
});

test('rejects websocket upgrade without a browser token when API_KEY is set', async () => {
  process.env.API_KEY = 'legacy-secret';
  delete process.env.SERVICE_TOKENS;
  const outcome = await connect();
  assert.equal(outcome.kind, 'rejection');
  assert.equal(outcome.statusCode, 401);
  delete process.env.API_KEY;
});

test('accepts websocket upgrade with the legacy browser token when API_KEY is set', async () => {
  process.env.API_KEY = 'legacy-secret';
  delete process.env.SERVICE_TOKENS;
  const outcome = await connect('legacy-secret');
  assert.equal(outcome.kind, 'upgrade');
  assert.equal(outcome.statusCode, 101);
  delete process.env.API_KEY;
});
