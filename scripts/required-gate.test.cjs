const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('required gate runs the server unit suite before browser E2E', () => {
  const script = fs.readFileSync(path.join(__dirname, 'required-gate.sh'), 'utf8');
  const serverTests = script.indexOf('npm run test -w @ai-agent-board/server');
  const e2e = script.indexOf('npm run test:e2e:required');

  assert.notEqual(serverTests, -1, 'required gate must run the server unit suite');
  assert.ok(serverTests < e2e, 'server unit tests must run before browser E2E');
});
