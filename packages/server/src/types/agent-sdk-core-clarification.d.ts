import type { ClarificationRequestPayload, TaskClarificationAnswer } from '../types.js';

declare module '@codewithdan/agent-sdk-core' {
  interface AgentEventMetadata {
    clarification_request?: ClarificationRequestPayload;
    clarification_answer?: TaskClarificationAnswer;
  }
}
