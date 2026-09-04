import { Router, type Request, type Response } from 'express';
import type { ProjectRepository } from '../repositories/project-types.js';
import { asyncHandler } from './helpers.js';
import {
  JiraImportConflictError,
  JiraImportNotConfiguredError,
  type JiraImportExecutor,
  toSafeJiraImportFailure,
} from '../jira/import-execution.js';

async function getProjectForImport(projects: ProjectRepository, value: unknown) {
  if (typeof value === 'string' && value) return projects.getById(value);
  return projects.getDefault();
}

export function createJiraRouter(projects: ProjectRepository, jiraImportExecutor: JiraImportExecutor): Router {
  const router = Router();

  router.post('/import-assigned', asyncHandler(async (req: Request, res: Response) => {
    const project = await getProjectForImport(projects, req.body.projectId);
    if (!project) {
      res.status(400).json({ error: 'projectId is invalid' });
      return;
    }

    try {
      const execution = await jiraImportExecutor.executeProjectImport(project, 'manual');
      if (execution.status === 'skipped_overlap') {
        res.status(409).json({ error: 'Jira import already running for this project.' });
        return;
      }
      res.json(execution.result);
    } catch (err: unknown) {
      if (err instanceof JiraImportNotConfiguredError) {
        res.status(503).json({ error: err.message });
        return;
      }
      if (err instanceof JiraImportConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      const failure = toSafeJiraImportFailure(err);
      if (failure.category === 'jira_not_configured') {
        res.status(503).json({ error: failure.message });
        return;
      }
      res.status(502).json({ error: failure.message });
    }
  }));

  return router;
}
