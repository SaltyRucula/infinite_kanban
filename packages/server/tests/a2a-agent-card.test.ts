import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeA2AAgentCard } from '../src/services/a2a-agent-card.js';

test('normalizes a supported JSON-RPC A2A Agent Card for the trusted directory', () => {
  const card = normalizeA2AAgentCard({
    name: 'Implementation Agent',
    description: 'Works on board tickets.',
    version: '1.0.0',
    capabilities: { streaming: true },
    supportedInterfaces: [{
      url: 'https://agents.example.test/a2a',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    }],
    skills: [{
      id: 'implementation',
      name: 'Implementation',
      description: 'Implements changes.',
      tags: ['coding', 'typescript'],
    }],
  });

  assert.deepEqual(card, {
    name: 'Implementation Agent',
    description: 'Works on board tickets.',
    version: '1.0.0',
    endpoint: 'https://agents.example.test/a2a',
    protocolVersion: '1.0',
    skills: [{ id: 'implementation', name: 'Implementation', tags: ['coding', 'typescript'] }],
  });
});

test('rejects an Agent Card without a usable JSON-RPC HTTPS interface', () => {
  assert.throws(
    () => normalizeA2AAgentCard({
      name: 'Unsupported Agent',
      description: 'Does not offer the board-supported transport.',
      version: '1.0.0',
      capabilities: {},
      supportedInterfaces: [{
        url: 'ftp://agents.example.test/a2a',
        transport: 'GRPC',
        protocolVersion: '1.0',
      }],
    }),
    /usable JSON-RPC HTTPS interface/,
  );
});
