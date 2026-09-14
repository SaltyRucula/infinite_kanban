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
  if (sessions.length === 0) return null;

  if (liveSessionId) {
    const live = sessions.find((session) => session.sessionId === liveSessionId);
    if (live) {
      return { sessionId: live.sessionId, baseUrl: live.baseUrl };
    }
  }

  const newest = sessions.reduce((latest, candidate) =>
    candidate.updatedAt > latest.updatedAt ? candidate : latest);
  return { sessionId: newest.sessionId, baseUrl: newest.baseUrl };
}
