import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInfo } from '@codewithdan/agent-sdk-core';
import { detectAvailableAgents } from '../src/services/agent-detection.js';

test('agent detection exposes only OpenCode', async () => {
  const agents = await detectAvailableAgents({
    detectAgents: async () => [
      { name: 'copilot', displayName: 'Copilot', available: true } as AgentInfo,
      { name: 'opencode', displayName: 'OpenCode', available: true } as AgentInfo,
    ],
  });
  assert.deepEqual(agents.map((agent) => agent.name), ['opencode']);
});
