import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAllowedA2AUrl } from '../src/cards.ts';

function allowed(url: string): boolean {
  return isAllowedA2AUrl(new URL(url));
}

test('https is allowed anywhere', () => {
  for (const url of [
    'https://agents.example.com/a2a',
    'https://10.190.52.50:9000/a2a',
    'https://joses-macbook.local/a2a',
  ]) {
    assert.equal(allowed(url), true, url);
  }
});

test('http is allowed on addresses that are not publicly routable', () => {
  // Agents run on people's own machines, so a laptop on the LAN must be able
  // to join without a certificate or a tunnel.
  for (const url of [
    'http://localhost:9000/a2a',
    'http://dev.localhost/a2a',
    'http://127.0.0.1:9000/a2a',
    'http://127.1.2.3/a2a',
    'http://[::1]:9000/a2a',
    'http://10.190.52.50:9000/a2a',
    'http://10.0.0.1/a2a',
    'http://172.16.0.9/a2a',
    'http://172.31.255.254/a2a',
    'http://192.168.1.42:8099/a2a',
    'http://169.254.10.10/a2a',
    'http://joses-macbook.local:9000/a2a',
    'http://[fd00::1]:9000/a2a',
    'http://[fe80::1]:9000/a2a',
  ]) {
    assert.equal(allowed(url), true, url);
  }
});

test('http is refused for anything reachable from the public internet', () => {
  for (const url of [
    'http://agents.example.com/a2a',
    'http://93.184.216.34/a2a',
    'http://172.15.0.1/a2a',   // just below the RFC 1918 block
    'http://172.32.0.1/a2a',   // just above it
    'http://192.167.1.1/a2a',
    'http://192.169.1.1/a2a',
    'http://11.0.0.1/a2a',
    'http://169.253.1.1/a2a',
    'http://[2606:4700::1111]/a2a',
    'http://evil.local.example.com/a2a',
  ]) {
    assert.equal(allowed(url), false, url);
  }
});

test('non-http(s) schemes are always refused', () => {
  for (const url of ['ftp://10.0.0.1/a2a', 'file:///etc/passwd', 'ws://10.0.0.1/a2a', 'gopher://10.0.0.1/']) {
    assert.equal(allowed(url), false, url);
  }
});

test('obfuscated IPv4 forms are normalized before the policy sees them', () => {
  // WHATWG URL parsing canonicalizes hex, octal and decimal IPv4 forms, so a
  // peer cannot smuggle a public address past the private-range check (or a
  // private one past an allowlist).
  assert.equal(new URL('http://0x0a.0.0.1/a2a').hostname, '10.0.0.1');
  assert.equal(allowed('http://0x0a.0.0.1/a2a'), true);     // -> 10.0.0.1, private
  assert.equal(new URL('http://2130706433/a2a').hostname, '127.0.0.1');
  assert.equal(allowed('http://2130706433/a2a'), true);     // -> loopback
  assert.equal(new URL('http://010.0.0.1/a2a').hostname, '8.0.0.1');
  assert.equal(allowed('http://010.0.0.1/a2a'), false);     // -> 8.0.0.1, public
});

test('out-of-range dotted quads never reach the policy', () => {
  // URL parsing rejects them outright, so there is no "999.0.0.1 is a domain
  // name" ambiguity for the private-range check to get wrong.
  assert.throws(() => new URL('http://999.0.0.1/a2a'));
  assert.throws(() => new URL('http://10.0.0.999/a2a'));
});
