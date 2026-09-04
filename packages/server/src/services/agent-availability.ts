import type { AgentType } from '../types.js';
import type { AgentInfo } from '../../../../shared/types.js';

export function findAgentInfo(
  availableAgents: readonly AgentInfo[],
  agentType: AgentType | undefined,
): AgentInfo | undefined {
  if (!agentType) return undefined;
  return availableAgents.find((agent) => agent.name === agentType);
}

export function isAgentAvailable(
  availableAgents: readonly AgentInfo[],
  agentType: AgentType | undefined,
): boolean {
  return findAgentInfo(availableAgents, agentType)?.available === true;
}
