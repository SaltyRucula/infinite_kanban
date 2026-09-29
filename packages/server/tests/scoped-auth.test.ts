import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import test from 'node:test';

async function load() { return import(`../src/middleware/auth.js?test=${Date.now()}-${Math.random()}`); }

test('legacy API_KEY remains accepted', async()=>{ process.env.API_KEY='legacy-secret'; delete process.env.SERVICE_TOKENS; const {authenticateToken}=await load(); assert.equal(authenticateToken('legacy-secret').legacy,true); delete process.env.API_KEY; });
test('hashed service token receives only configured safe scopes', async()=>{ delete process.env.API_KEY; process.env.SERVICE_TOKENS=JSON.stringify([{sha256:'2f5b78396adc3b6cb3d9c5ff6a5e428e1f53caf69e6e40e3caa9155c898f56ae',scopes:['projects:read','orchestrations:create','jira:import','projects:write','tasks:delete']}]); const {authenticateToken,isValidToken}=await load(); const auth=authenticateToken('service-secret'); assert.equal(auth.authenticated,true); assert.deepEqual(auth.scopes,['projects:read','orchestrations:create','jira:import']); assert.equal(isValidToken('service-secret'),false); delete process.env.SERVICE_TOKENS; });

test('worker lifecycle mutations require workers:manage for service credentials', async () => {
  delete process.env.API_KEY;
  process.env.SERVICE_TOKENS = JSON.stringify([{ token: 'read-only', scopes: ['projects:read'] }, { token: 'worker-manager', scopes: ['workers:manage'] }]);
  const { authMiddleware } = await load();
  const app = express();
  app.use(authMiddleware);
  app.patch('/workers/:id/status', (_req, res) => res.sendStatus(204));
  app.delete('/workers/:id', (_req, res) => res.sendStatus(204));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${baseUrl}/workers/worker-1/status`, { method: 'PATCH' })).status, 401);
    assert.equal((await fetch(`${baseUrl}/workers/worker-1`, { method: 'DELETE', headers: { authorization: 'Bearer read-only' } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/workers/worker-1/status`, { method: 'PATCH', headers: { authorization: 'Bearer worker-manager' } })).status, 204);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.SERVICE_TOKENS;
  }
});
