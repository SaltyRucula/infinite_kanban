import { Router, type Request, type Response } from 'express';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { TaskRepository } from '../repositories/types.js';
import { asyncHandler, broadcastTaskUpdate } from './helpers.js';
import { GitHubIssueClient } from '../github/client.js';
import { importGitHubIssues } from '../github/importer.js';

async function projectForImport(projects: ProjectRepository, value: unknown) {
  if (typeof value === 'string' && value) return projects.getById(value);
  return projects.getDefault();
}

export function createGitHubRouter(projects: ProjectRepository, tasks: Pick<TaskRepository, 'createIdempotent'>): Router {
  const router = Router();

  router.post('/import-issues', asyncHandler(async (req: Request, res: Response) => {
    const project = await projectForImport(projects, req.body.projectId);
    if (!project) { res.status(400).json({ error: 'projectId is invalid' }); return; }
    if (!project.repoUrl) { res.status(400).json({ error: 'project has no GitHub repository URL configured' }); return; }

    try {
      const issues = await new GitHubIssueClient(project.repoUrl).listOpenIssues();
      const result = await importGitHubIssues({ repo: tasks, project, issues });
      for (const task of result.tasks) broadcastTaskUpdate(task);
      res.json(result);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : 'GitHub import failed.' });
    }
  }));

  return router;
}
