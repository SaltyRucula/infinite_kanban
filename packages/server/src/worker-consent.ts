import type { Task, Worker } from './types.js';

export function workerAcceptsTask(worker: Worker, task: Task): boolean {
  const acceptedProjects = new Set(worker.acceptedProjectIds ?? []);
  if (!acceptedProjects.has(task.projectId)) return false;

  const acceptedLabels = new Set((worker.acceptedLabels ?? []).map((label) => label.toLowerCase()));
  return task.labels.every((label) => acceptedLabels.has(label.toLowerCase()));
}
