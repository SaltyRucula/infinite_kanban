import type { AgentEvent, WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';

export type Config = { readonly workerId: string; readonly workerToken: string; readonly serverUrl: string };
export type WorkerRequest = <T>(config: Config, endpoint: string, init?: RequestInit) => Promise<T>;
export type ClaimResult = { readonly task: WorkerTaskAssignment; readonly claimToken: string };

function urlFor(serverUrl: string, endpoint: string): string {
  return `${serverUrl.replace(/\/$/, '')}/api/workers${endpoint}`;
}

export async function request<T>(config: Config, endpoint: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(urlFor(config.serverUrl, endpoint), {
    ...init,
    headers: {
      authorization: `Bearer ${config.workerToken}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`worker API ${response.status}: ${JSON.stringify(body)}`);
  return body as T;
}

export async function requestWithLoggedFailure<T>(scope: string, action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error: unknown) {
    console.error(`[worker] ${scope} failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function sendEvent(config: Config, task: WorkerTaskAssignment, claimToken: string, event: AgentEvent): Promise<void> {
  await request(config, `/me/tasks/${task.id}/events`, {
    method: 'POST',
    headers: { 'x-worker-claim': claimToken },
    body: JSON.stringify(event),
  });
}

export async function fetchAssignments(config: Config, requestFn: WorkerRequest = request): Promise<readonly WorkerTaskAssignment[] | undefined> {
  const response = await requestWithLoggedFailure('assignment poll', () => requestFn<{ tasks: readonly WorkerTaskAssignment[] }>(config, '/me/assignments'));
  return response?.tasks;
}

export async function claimTask(config: Config, taskId: string, requestFn: WorkerRequest = request): Promise<{ readonly task: WorkerTaskAssignment; readonly claimToken: string } | undefined> {
  return requestWithLoggedFailure('task claim', () => requestFn<{ task: WorkerTaskAssignment; claimToken: string }>(config, `/me/tasks/${taskId}/claim`, { method: 'POST' }));
}

export async function completeTaskFailure(config: Config, taskId: string, claimToken: string, error: string, requestFn: WorkerRequest = request): Promise<void> {
  await requestWithLoggedFailure('task completion', () => requestFn(config, `/me/tasks/${taskId}/complete`, {
    method: 'POST',
    headers: { 'x-worker-claim': claimToken },
    body: JSON.stringify({ status: 'failed', error }),
  }));
}
