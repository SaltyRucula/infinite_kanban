import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import type { WorkerRepository } from '../repositories/worker-types.js';
import type { Worker } from '../types.js';

export interface AuthenticatedWorker extends Worker {
  readonly tokenHash: string;
}

export function claimTokenHash(req: Request): string | undefined {
  const token = req.header('x-worker-claim');
  return token ? crypto.createHash('sha256').update(token).digest('hex') : undefined;
}

export function workerAuth(repo: WorkerRepository) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) { res.status(401).json({ error: 'worker token required' }); return; }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const worker = await repo.getByTokenHash(tokenHash);
    if (!worker || worker.status === 'disabled') { res.status(401).json({ error: 'invalid worker token' }); return; }
    res.locals.worker = worker;
    next();
  };
}

export function authenticatedWorker(res: Response): AuthenticatedWorker {
  return res.locals.worker as AuthenticatedWorker;
}
