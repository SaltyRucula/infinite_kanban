import { Router, type Request, type Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { A2AWorkflowRole } from '../types.js';
import type { A2AAgentRepository } from '../repositories/a2a-agent-types.js';
import { fetchA2AAgentCard } from '../services/a2a-agent-directory.js';
import { errorMessage } from '../utils.js';
import { asyncHandler, paramId } from './helpers.js';

export interface A2AAgentsRouterDeps {
  fetchCard?: typeof fetchA2AAgentCard;
  projectExists: (projectId: string) => Promise<boolean>;
}

function parseRoles(value: unknown): A2AWorkflowRole[] | undefined {
  if (!Array.isArray(value) || value.some((role) => role !== 'implementation' && role !== 'review')) return undefined;
  return [...new Set(value)] as A2AWorkflowRole[];
}

export function createA2AAgentsRouter(repo: A2AAgentRepository, deps: A2AAgentsRouterDeps): Router {
  const router = Router();
  const fetchCard = deps.fetchCard ?? fetchA2AAgentCard;

  router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    res.json(await repo.getAll());
  }));

  router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const agent = await repo.getById(paramId(req));
    if (!agent) { res.status(404).json({ error: 'A2A agent not found' }); return; }
    res.json(agent);
  }));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const agentCardUrl = req.body?.agentCardUrl;
    if (typeof agentCardUrl !== 'string' || !agentCardUrl.trim()) {
      res.status(400).json({ error: 'agentCardUrl must be a non-empty string' });
      return;
    }
    try {
      const card = await fetchCard(agentCardUrl.trim());
      const now = Date.now();
      const agent = await repo.register({ id: uuid(), agentCardUrl: agentCardUrl.trim(), ...card, enabled: req.body?.enabled !== false, now });
      res.status(201).json(agent);
    } catch (error) {
      const message = errorMessage(error);
      res.status(/UNIQUE|unique|duplicate/i.test(message) ? 409 : 400).json({ error: message });
    }
  }));

  router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
    if (typeof req.body?.enabled !== 'boolean') { res.status(400).json({ error: 'enabled must be a boolean' }); return; }
    const agent = await repo.setEnabled(paramId(req), req.body.enabled, Date.now());
    if (!agent) { res.status(404).json({ error: 'A2A agent not found' }); return; }
    res.json(agent);
  }));

  router.put('/:id/projects/:projectId/roles', asyncHandler(async (req: Request, res: Response) => {
    const roles = parseRoles(req.body?.roles);
    if (!roles) { res.status(400).json({ error: 'roles must contain only implementation and review' }); return; }
    if (!(await deps.projectExists(String(req.params.projectId)))) { res.status(404).json({ error: 'project not found' }); return; }
    const agent = await repo.setProjectRoles(paramId(req), String(req.params.projectId), roles, Date.now());
    if (!agent) { res.status(404).json({ error: 'A2A agent not found' }); return; }
    res.json(agent);
  }));

  router.post('/:id/refresh', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const existing = await repo.getById(id);
    if (!existing) { res.status(404).json({ error: 'A2A agent not found' }); return; }
    try {
      const card = await fetchCard(existing.agentCardUrl);
      const agent = await repo.refresh(id, { ...card, now: Date.now() });
      res.json(agent);
    } catch (error) {
      const agent = await repo.recordRefreshFailure(id, errorMessage(error), Date.now());
      res.status(502).json({ error: errorMessage(error), agent });
    }
  }));

  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    if (!(await repo.delete(paramId(req)))) { res.status(404).json({ error: 'A2A agent not found' }); return; }
    res.status(204).send();
  }));

  return router;
}
