import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRegisterE2EClarificationProvider } from '../src/services/e2e-clarification-provider-gate.js';

test('shouldRegisterE2EClarificationProvider does not enable the fake provider in production', () => {
  const env = {
    AGENTBOARD_E2E_CLARIFICATION_PROVIDER: '1',
    NODE_ENV: 'production',
  } satisfies NodeJS.ProcessEnv;

  assert.equal(shouldRegisterE2EClarificationProvider(env), false);
});

test('shouldRegisterE2EClarificationProvider enables the fake provider outside production', () => {
  const testEnv = {
    AGENTBOARD_E2E_CLARIFICATION_PROVIDER: '1',
    NODE_ENV: 'test',
  } satisfies NodeJS.ProcessEnv;
  const devEnv = {
    AGENTBOARD_E2E_CLARIFICATION_PROVIDER: '1',
    NODE_ENV: 'development',
  } satisfies NodeJS.ProcessEnv;

  assert.equal(shouldRegisterE2EClarificationProvider(testEnv), true);
  assert.equal(shouldRegisterE2EClarificationProvider(devEnv), true);
});
