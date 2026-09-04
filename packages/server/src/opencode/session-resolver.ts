export interface OpenCodeSessionLike {
  readonly id: string;
  readonly title?: string;
  readonly directory: string;
  readonly time: { readonly updated: number };
}

export interface OpenCodeSessionClient {
  session: {
    get(args: { path: { id: string } }): Promise<{ data?: OpenCodeSessionLike }>;
    list(): Promise<{ data?: readonly OpenCodeSessionLike[] }>;
  };
}

export interface ResolvedOpenCodeSession {
  readonly sessionId: string;
  readonly directory: string;
}

/**
 * Resolve the OpenCode session backing a task: prefer the live in-memory
 * session (still running), otherwise fall back to the most recently updated
 * OpenCode session whose title matches the task id — OpenCode sessions are
 * created with `title: taskId` and can outlive the task's in-memory entry
 * (e.g. after a failure that did not tear down the remote session).
 */
export async function resolveTaskOpenCodeSession(
  client: OpenCodeSessionClient,
  taskId: string,
  liveSessionId: string | null,
): Promise<ResolvedOpenCodeSession | null> {
  if (liveSessionId) {
    const live = await client.session.get({ path: { id: liveSessionId } });
    if (live.data) return { sessionId: liveSessionId, directory: live.data.directory };
  }

  const list = await client.session.list();
  const matches = (list.data ?? []).filter((session) => session.title === taskId);
  if (matches.length === 0) return null;

  const latest = matches.reduce((newest, candidate) =>
    candidate.time.updated > newest.time.updated ? candidate : newest);
  return { sessionId: latest.id, directory: latest.directory };
}
