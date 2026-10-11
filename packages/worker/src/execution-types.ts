import type { ExecutionRole } from '@ai-agent-board/shared/execution.js';

/**
 * Endpoint-local configuration. None of this travels to the board: the harness,
 * the model and the checkout paths are this process's business.
 */
export interface ExecutionEndpointConfig {
  /** A name from the harness registry; validated when the harness is resolved. */
  harness: string;
  model?: string;
  roles: ExecutionRole[];
  projects: string[];
  /** Portable repository identity → local checkout on this machine. */
  repositories: Record<string, string>;
  stateDirectory: string;
  capabilities: string[];
  checks: { name: string; command: string; args: string[] }[];
}

export interface HarnessInput {
  directory: string;
  prompt: string;
  readOnly: boolean;
  deadline: number;
  signal?: AbortSignal;
}

/** Run one turn in `directory` and return the model's final text. */
export type ExecutionHarness = (input: HarnessInput) => Promise<string>;
