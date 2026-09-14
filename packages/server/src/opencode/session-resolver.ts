import type { RegisteredWorkerOpenCodeSession } from '../repositories/worker-types.js';

export interface OpenCodeSessionClient {}

export type ResolvedOpenCodeSession = {
  readonly sessionId: string;
  readonly baseUrl: string;
};

export { type RegisteredWorkerOpenCodeSession };

export function resolveTaskOpenCodeSession(
  sessions: readonly RegisteredWorkerOpenCodeSession[],
  liveSessionId: string | null,
): ResolvedOpenCodeSession | null {
  if (!liveSessionId || sessions.length === 0) return null;

  const live = sessions.find((session) => session.sessionId === liveSessionId);
  return live ? { sessionId: live.sessionId, baseUrl: live.baseUrl } : null;
}
