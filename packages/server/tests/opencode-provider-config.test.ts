import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenCodeProviderConfig } from '../src/services/agent-manager.js';

test('createOpenCodeProviderConfig uses managed mode when OPENCODE_BASE_URL is unset', () => {
  const config = createOpenCodeProviderConfig({});
  assert.equal(config.mode, 'managed');
  assert.equal(config.baseUrl, undefined);
});

test('createOpenCodeProviderConfig uses existing-server mode for a valid loopback URL', () => {
  const config = createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'http://127.0.0.1:4096/' });
  assert.equal(config.mode, 'existing-server');
  assert.equal(config.baseUrl, 'http://127.0.0.1:4096');
});

test('createOpenCodeProviderConfig accepts explicit default ports from raw input', () => {
  const explicitHttpDefault = createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'http://127.0.0.1:80' });
  assert.equal(explicitHttpDefault.mode, 'existing-server');
  assert.equal(explicitHttpDefault.baseUrl, 'http://127.0.0.1');

  const explicitHttpsDefault = createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'https://localhost:443' });
  assert.equal(explicitHttpsDefault.mode, 'existing-server');
  assert.equal(explicitHttpsDefault.baseUrl, 'https://localhost');
});

test('createOpenCodeProviderConfig accepts localhost and IPv6 loopback URLs', () => {
  const localhost = createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'http://localhost:4096' });
  assert.equal(localhost.mode, 'existing-server');
  assert.equal(localhost.baseUrl, 'http://localhost:4096');

  const ipv6 = createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'http://[::1]:4096/' });
  assert.equal(ipv6.mode, 'existing-server');
  assert.equal(ipv6.baseUrl, 'http://[::1]:4096');
});

test('createOpenCodeProviderConfig rejects malformed and non-loopback URLs', () => {
  assert.throws(
    () => createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'not-a-url' }),
    /must be a valid absolute URL/,
  );
  assert.throws(
    () => createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'https://example.com:4096' }),
    /must resolve to a loopback host/,
  );
  assert.throws(
    () => createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'ftp://127.0.0.1:4096' }),
    /must use http or https/,
  );
  assert.throws(
    () => createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'https://dev.local:4096' }),
    /must resolve to a loopback host/,
  );
  assert.throws(
    () => createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'http://user:secret@127.0.0.1:4096' }),
    /must not include credentials/,
  );
});

test('createOpenCodeProviderConfig rejects loopback URLs without explicit port or with path/query/hash decorations', () => {
  assert.throws(
    () => createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'http://127.0.0.1' }),
    /must include an explicit port/,
  );
  assert.throws(
    () => createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'http://127.0.0.1:4096/opencode' }),
    /must not include a path/,
  );
  assert.throws(
    () => createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'http://127.0.0.1:4096?foo=bar' }),
    /must not include credentials or fragments/,
  );
  assert.throws(
    () => createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'http://127.0.0.1:4096#fragment' }),
    /must not include credentials or fragments/,
  );
});

test('createOpenCodeProviderConfig rejects explicit raw userinfo and pre-normalized non-root paths', () => {
  assert.throws(
    () => createOpenCodeProviderConfig({ OPENCODE_BASE_URL: 'http://@127.0.0.1:4096' }),
    /must not include credentials/,
  );

  const nonRootPaths = [
    'http://127.0.0.1:4096/.',
    'http://127.0.0.1:4096/..',
    'http://127.0.0.1:4096/%2e',
    'http://127.0.0.1:4096/%2E%2e',
    'http://127.0.0.1:4096/%2e/%2e',
  ] as const;

  for (const url of nonRootPaths) {
    assert.throws(
      () => createOpenCodeProviderConfig({ OPENCODE_BASE_URL: url }),
      /must not include a path/,
      `expected ${url} to be rejected as non-root raw path`,
    );
  }
});
