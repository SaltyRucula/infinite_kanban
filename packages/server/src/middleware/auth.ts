import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export type ServiceScope = 'projects:read' | 'agents:read' | 'a2a:send' | 'a2a-agents:read' | 'a2a-agents:manage' | 'workers:register' | 'workers:manage';
const ALL_SERVICE_SCOPES: ServiceScope[] = ['projects:read', 'agents:read', 'a2a:send', 'a2a-agents:read', 'a2a-agents:manage', 'workers:register', 'workers:manage'];

interface Credential { token?: string; sha256?: string; id?: string; scopes: ServiceScope[] }

function credentials(): Credential[] {
  const raw = process.env.SERVICE_TOKENS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ token?: string; sha256?: string; id?: string; scopes?: string[] }>;
    return parsed.filter(c => c.token || c.sha256).map(c => ({ token: c.token, sha256: c.sha256?.toLowerCase(), ...(typeof c.id === 'string' && c.id.trim() ? { id: c.id.trim() } : {}), scopes: (c.scopes ?? []).filter(s => ALL_SERVICE_SCOPES.includes(s as ServiceScope)) as ServiceScope[] }));
  } catch { console.error('[auth] SERVICE_TOKENS must be a JSON array'); return []; }
}

function safeEqual(a: string, b: string): boolean {
  const aa=Buffer.from(a), bb=Buffer.from(b); return aa.length === bb.length && crypto.timingSafeEqual(aa,bb);
}

export function authenticateToken(token: string | undefined): { authenticated: boolean; legacy: boolean; scopes: ServiceScope[]; id?: string } {
  if (!token) return { authenticated: false, legacy: false, scopes: [] };
  const apiKey=process.env.API_KEY;
  if (apiKey && safeEqual(token,apiKey)) return { authenticated:true,legacy:true,scopes:ALL_SERVICE_SCOPES };
  const digest=crypto.createHash('sha256').update(token).digest('hex');
  const match=credentials().find(c => c.token ? safeEqual(token,c.token) : !!c.sha256 && safeEqual(digest,c.sha256));
  return match ? { authenticated:true,legacy:false,scopes:match.scopes, ...(match.id ? { id: match.id } : {}) } : { authenticated:false,legacy:false,scopes:[] };
}

function requiredScope(req: Request): ServiceScope | undefined {
  const p=req.path, method=req.method;
  if (p === '/health') return undefined;
  if (p.startsWith('/workers/me')) return undefined;
  if (p === '/workers/register' && method === 'POST') return 'workers:register';
  if (p === '/workers/enrollment-codes' && method === 'POST') return 'workers:manage';
  if (/^\/workers\/[^/]+(?:\/status)?$/.test(p) && (method === 'PATCH' || method === 'DELETE')) return 'workers:manage';
  if (p === '/workers') return undefined;
  if (p === '/agents') return undefined;
  if (p === '/agents/refresh') return 'agents:read';
  if (p === '/a2a-agents' && method === 'GET') return 'a2a-agents:read';
  if (/^\/a2a-agents\/[^/]+$/.test(p) && method === 'GET') return 'a2a-agents:read';
  if (p.startsWith('/a2a-agents')) return 'a2a-agents:manage';
  if (p.startsWith('/projects')) return undefined;
  if (p.startsWith('/tasks') || p.startsWith('/groups')) {
    return undefined;
  }
  return undefined; // service credentials are denied for all non-allowlisted mutations
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const hasLegacyKey = Boolean(process.env.API_KEY);
  const serviceCredentials = credentials();
  const scope = requiredScope(req);
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const auth = authenticateToken(token);
  if (auth.authenticated) {
    res.locals.principal = {
      id: auth.legacy ? 'legacy-admin' : auth.id ?? `service:${digestToken(token ?? '')}`,
      kind: auth.legacy ? 'legacy-admin' : 'service',
    };
  }
  const enrollmentRegistration = req.path === '/workers/register'
    && req.method === 'POST'
    && typeof req.body?.enrollmentCode === 'string'
    && req.body.enrollmentCode.trim().length > 0;

  // A deployment with no API_KEY and no SERVICE_TOKENS is open by choice: its
  // access boundary is the network, not this middleware. Such a request is
  // still given a principal, because routes that record *who* owns something
  // (worker enrollment codes, and the worker rows they create) need an owner
  // id. Without it those routes answer 401 on a deployment where every other
  // endpoint is open — leaving no way to enrol a worker at all.
  //
  // The kind is deliberately not 'service': service principals are scoped to
  // the workers they own, while an open deployment has a single operator who
  // should see everything.
  if (!hasLegacyKey && serviceCredentials.length === 0 && !auth.authenticated) {
    res.locals.principal = { id: 'open-deployment', kind: 'open-deployment' };
  }

  if (req.path.startsWith('/workers/me')) { next(); return; }

  // An enrollment code is the credential for a newly bootstrapped worker.
  // The route validates and atomically consumes it before registering.
  if (enrollmentRegistration) { next(); return; }

  // API_KEY retains the legacy "protect every API route" behavior.
  if (hasLegacyKey) {
    if (!auth.authenticated) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!auth.legacy && (!scope || !auth.scopes.includes(scope))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
    return;
  }

  // A service-token-only deployment keeps the existing browser/API surface
  // behind its outer access boundary, but requires scoped auth for the narrow
  // orchestration facade and agent refresh mutation.
  if (!scope || (serviceCredentials.length === 0 && scope !== 'workers:register')) { next(); return; }
  if (!auth.authenticated) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (!auth.scopes.includes(scope)) { res.status(403).json({ error: 'forbidden' }); return; }
  next();
}

function digestToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function isValidToken(token: string | undefined): boolean {
  const auth = authenticateToken(token);
  return auth.authenticated && auth.legacy;
}

export function isValidWebSocketToken(token: string | undefined): boolean {
  if (!process.env.API_KEY) return true;
  return isValidToken(token);
}
