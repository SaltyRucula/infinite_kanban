import type { AgentEvent, Task } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';

/** Approved proposals become tasks keyed by this external identity. */
export const WORK_REQUEST_EXTERNAL_SOURCE = 'work-request';

export function workRequestExternalKey(sourceTaskId: string, eventId: string): string {
  return `${sourceTaskId}:${eventId}`;
}

export function isWorkRequestEvent(event: AgentEvent): boolean {
  return event.type === 'request_work' && Boolean(event.metadata?.workRequest);
}

/**
 * Count proposals on a task that still await an operator decision: neither
 * dismissed (durable dismissal event) nor approved (task with the proposal's
 * external identity exists).
 */
export async function countPendingWorkRequests(
  repo: Pick<TaskRepository, 'getEventsByTaskId' | 'getByExternalIdentity'>,
  task: Pick<Task, 'id' | 'projectId'>,
): Promise<number> {
  const events = await repo.getEventsByTaskId(task.id);
  const dismissed = new Set(
    events.flatMap((event) => event.metadata?.dismissedWorkRequestEventId ? [event.metadata.dismissedWorkRequestEventId] : []),
  );
  let pending = 0;
  for (const event of events) {
    if (!isWorkRequestEvent(event) || dismissed.has(event.id)) continue;
    const approved = await repo.getByExternalIdentity(task.projectId, WORK_REQUEST_EXTERNAL_SOURCE, workRequestExternalKey(task.id, event.id));
    if (!approved) pending += 1;
  }
  return pending;
}
