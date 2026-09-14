import type { AgentType } from '@/types';

export const AGENT_DISPLAY: Record<AgentType, { emoji: string; label: string }> = {
  opencode: { emoji: '', label: 'OpenCode' },
};

/** Options array derived from AGENT_DISPLAY */
export const AGENT_OPTIONS: { value: AgentType; label: string; emoji: string }[] = (
  Object.entries(AGENT_DISPLAY) as [AgentType, { emoji: string; label: string }][]
).map(([value, { emoji, label }]) => ({ value, label, emoji }));

/** Safe lookup — returns OpenCode worker label for unknown or missing agent types */
export function getAgentDisplay(agentType?: string): { emoji: string; label: string } {
  if (agentType && agentType in AGENT_DISPLAY) {
    return AGENT_DISPLAY[agentType as AgentType];
  }
  return { emoji: '', label: 'OpenCode Worker' };
}

