import type { AgentInfo as CoreAgentInfo } from '@codewithdan/agent-sdk-core';
import { detectAgents as detectCoreAgents } from '@codewithdan/agent-sdk-core';
import type { AgentInfo } from '../types.js';

interface DetectAvailableAgentsOptions {
  detectAgents?: () => Promise<CoreAgentInfo[]>;
}

export async function detectAvailableAgents(options: DetectAvailableAgentsOptions = {}): Promise<AgentInfo[]> {
  const detected = await (options.detectAgents ?? detectCoreAgents)();
  return detected
    .filter((agent) => agent.name === 'opencode')
    .map((agent) => ({
      name: 'opencode' as const,
      displayName: agent.displayName,
      available: agent.available,
      ...(agent.version ? { version: agent.version } : {}),
      ...(agent.reason ? { reason: agent.reason } : {}),
    }));
}
