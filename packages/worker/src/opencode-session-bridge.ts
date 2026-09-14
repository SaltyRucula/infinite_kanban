import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

type TaskSessionMapping = {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly baseUrl: string;
};

export type OpenCodeSessionBridgeRegistration = {
  readonly taskId: string;
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly baseUrl: string;
};

export type OpenCodeSessionBridgeOptions = {
  readonly port?: number;
};

const LOOPBACK_HOST = '127.0.0.1';
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertValidTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error('taskId must contain only letters, numbers, underscores, and hyphens');
  }
}

function normalizeLoopbackBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('baseUrl must be a non-empty string');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('baseUrl must be a valid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl protocol must be http or https');
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (!isLoopback) {
    throw new Error('baseUrl hostname must be loopback (localhost, 127.0.0.1, or [::1])');
  }
  if (!parsed.port) {
    throw new Error('baseUrl must include an explicit port');
  }
  if ((parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('baseUrl must not include path, query, hash, or userinfo');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function buildUiRouteDirectorySegment(workspacePath: string): string {
  const trimmed = workspacePath.trim();
  if (!trimmed) throw new Error('workspacePath must be a non-empty string');
  return Buffer.from(trimmed, 'utf8').toString('base64url');
}

function parseTaskIdFromRequest(request: IncomingMessage): { readonly ok: true; readonly taskId: string } | { readonly ok: false; readonly status: number; readonly message: string } {
  const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 2 || segments[0] !== 'session') {
    return { ok: false, status: 404, message: 'not found' };
  }
  const taskId = decodeURIComponent(segments[1] ?? '');
  if (!TASK_ID_PATTERN.test(taskId)) {
    return { ok: false, status: 400, message: 'invalid task id' };
  }
  return { ok: true, taskId };
}

function writeResponse(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end(body);
}

export function buildOpenCodeUiSessionUrl(baseUrl: string, workspacePath: string, sessionId: string): string {
  const normalizedBase = normalizeLoopbackBaseUrl(baseUrl);
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId || /[/?#]/.test(normalizedSessionId)) {
    throw new Error('sessionId must be a non-empty path-safe identifier');
  }
  const encodedDirectory = buildUiRouteDirectorySegment(workspacePath);
  return `${normalizedBase}/${encodedDirectory}/session/${encodeURIComponent(normalizedSessionId)}`;
}

export class OpenCodeSessionBridge {
  private readonly sessionsByTaskId = new Map<string, TaskSessionMapping>();

  private constructor(
    private readonly server: Server,
    private readonly boundPort: number,
  ) {}

  static async start(options: OpenCodeSessionBridgeOptions = {}): Promise<OpenCodeSessionBridge> {
    const server = createServer();
    const bridge = await new Promise<OpenCodeSessionBridge>((resolve, reject) => {
      server.on('error', reject);
      server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('failed to bind OpenCode session bridge to loopback'));
          return;
        }
        resolve(new OpenCodeSessionBridge(server, address.port));
      });
    });
    server.removeAllListeners('request');
    server.on('request', (request, response) => bridge.handleRequest(request, response));
    return bridge;
  }

  get port(): number {
    return this.boundPort;
  }

  get host(): string {
    return LOOPBACK_HOST;
  }

  register(input: OpenCodeSessionBridgeRegistration): string {
    assertValidTaskId(input.taskId);
    const mapping: TaskSessionMapping = {
      sessionId: input.sessionId.trim(),
      workspacePath: input.workspacePath,
      baseUrl: normalizeLoopbackBaseUrl(input.baseUrl),
    };
    if (!mapping.sessionId || /[/?#]/.test(mapping.sessionId)) {
      throw new Error('sessionId must be a non-empty path-safe identifier');
    }
    if (!mapping.workspacePath.trim()) {
      throw new Error('workspacePath must be a non-empty string');
    }
    this.sessionsByTaskId.set(input.taskId, mapping);
    return `http://${LOOPBACK_HOST}:${this.boundPort}/session/${input.taskId}`;
  }

  unregister(taskId: string): void {
    if (!TASK_ID_PATTERN.test(taskId)) return;
    this.sessionsByTaskId.delete(taskId);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeResponse(response, 405, 'method not allowed');
      return;
    }

    const parsed = parseTaskIdFromRequest(request);
    if (!parsed.ok) {
      writeResponse(response, parsed.status, parsed.message);
      return;
    }

    const mapping = this.sessionsByTaskId.get(parsed.taskId);
    if (!mapping) {
      writeResponse(response, 404, 'session mapping not found');
      return;
    }

    const location = buildOpenCodeUiSessionUrl(mapping.baseUrl, mapping.workspacePath, mapping.sessionId);
    response.statusCode = 302;
    response.setHeader('location', location);
    response.end();
  }
}
