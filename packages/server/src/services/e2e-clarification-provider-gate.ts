import { E2EClarificationProvider } from '../testing/e2e-clarification-provider.js';
import type { AgentManager } from './agent-manager.js';

export function shouldRegisterE2EClarificationProvider(env: NodeJS.ProcessEnv): boolean {
  return env.AGENTBOARD_E2E_CLARIFICATION_PROVIDER === '1' && env.NODE_ENV !== 'production';
}

export function registerE2EClarificationProvider(agentManager: AgentManager): void {
  agentManager.registerProvider(new E2EClarificationProvider());
  agentManager.setAvailableAgents(
    agentManager.getAvailableAgents().map((agent) => (agent.name === 'opencode'
      ? { ...agent, available: true, reason: undefined, version: 'e2e-clarification-provider' }
      : agent)),
  );
}
