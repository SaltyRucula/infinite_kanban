import express from 'express';
import { executionArtifacts } from '@ai-agent-board/a2a/execution.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { admitExecution, executeAssignment, type ExecutionEndpointConfig } from './execution-adapter.js';
import type { ExecutionAssignment, ExecutionResult } from '@ai-agent-board/shared/execution.js';
import { canonicalRepoUrl } from './repository-resolution.js';

interface StoredTask {
  id: string;
  contextId: string;
  status: {
    state: string;
    timestamp: string;
    message?: { messageId: string; role: string; parts: { text: string }[] };
  };
  artifacts: unknown[];
}
interface StoredExecution {
  assignment?: ExecutionAssignment;
  task: StoredTask;
}

/** Native v1 endpoint with durable assignment correlation. */
export async function startExecutionEndpoint(
  config: ExecutionEndpointConfig,
  options: {
    port?: number;
    execute?: (
      a: ExecutionAssignment,
      config: ExecutionEndpointConfig,
      signal: AbortSignal,
    ) => Promise<ExecutionResult>;
  } = {},
) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  const server = http.createServer(app);
  const stateFile = path.join(config.stateDirectory, 'execution-tasks.json');
  await fs.mkdir(config.stateDirectory, { recursive: true });
  const records: Record<string, StoredExecution> = JSON.parse(
    await fs.readFile(stateFile, 'utf8').catch((e) => {
      if (e.code === 'ENOENT') return '{}';
      throw e;
    }),
  );
  const active = new Map<string, AbortController>();
  const waiters = new Map<string, Set<() => void>>();
  let writes = Promise.resolve();
  let mutations = Promise.resolve();
  let closed = false;
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = mutations.catch(() => {}).then(operation);
    mutations = current.then(() => {});
    return current;
  };
  const persist = () => {
    const content = JSON.stringify(records);
    writes = writes.then(async () => {
      await fs.writeFile(stateFile + '.next', content, { mode: 0o600 });
      await fs.rename(stateFile + '.next', stateFile);
    });
    return writes;
  };
  const status = (task: StoredTask, state: string, text?: string) => {
    task.status = {
      state,
      timestamp: new Date().toISOString(),
      ...(text
        ? {
            message: { messageId: `${task.id}-status`, role: 'ROLE_AGENT', parts: [{ text }] },
          }
        : {}),
    };
  };
  const notify = (id: string) => {
    for (const resolve of waiters.get(id) ?? []) resolve();
    waiters.delete(id);
  };
  const isPending = (task: StoredTask) =>
    ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(task.status.state);
  const waitForTask = async (task: StoredTask) => {
    if (!isPending(task)) return;
    await new Promise<void>((resolve) => {
      const listeners = waiters.get(task.id) ?? new Set();
      listeners.add(resolve);
      waiters.set(task.id, listeners);
    });
  };
  for (const record of Object.values(records)) {
    if (isPending(record.task))
      status(record.task, 'TASK_STATE_FAILED', 'endpoint restarted during execution; no duplicate execution');
  }
  await persist();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app.get('/.well-known/agent-card.json', (_req, res) =>
    res.json({
      name: `Execution endpoint (${config.harness})`,
      description: 'Board-owned structured execution; harness configured locally',
      version: '1.0',
      supportedInterfaces: [{ url: baseUrl + '/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: false },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['application/json'],
      skills: config.roles.map((role) => ({
        id: role,
        name: role,
        description: `${role} with structured evidence`,
        tags: [
          'execution:v1',
          ...(role === 'review' ? ['review:snapshot'] : []),
          ...config.capabilities,
          ...Object.keys(config.repositories).map((r) => `repository:${canonicalRepoUrl(r)}`),
          ...config.projects.map((p) => `consent:${p}`),
        ],
      })),
    }),
  );
  app.get('/artifacts/:hash', async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.hash)) {
      res.sendStatus(400);
      return;
    }
    try {
      res
        .type('text/plain')
        .send(await fs.readFile(path.join(config.stateDirectory, 'artifacts', req.params.hash), 'utf8'));
    } catch {
      res.sendStatus(404);
    }
  });
  app.post('/a2a/v1', async (req, res) => {
    const request = req.body;
    const error = (code: number, message: string) =>
      res.json({ jsonrpc: '2.0', id: request?.id ?? null, error: { code, message } });
    if (req.get('A2A-Version') !== '1.0') {
      error(-32600, 'A2A-Version: 1.0 required');
      return;
    }
    if (request?.jsonrpc !== '2.0' || !request.params || typeof request.params !== 'object') {
      error(-32600, 'invalid JSON-RPC request');
      return;
    }
    try {
      const task = await serialize(async (): Promise<StoredTask | undefined> => {
        if (closed) {
          error(-32603, 'endpoint is shutting down');
          return;
        }
        if (request.method === 'SendMessage') {
          const configuration = request.params.configuration;
          if (
            configuration !== undefined &&
            (!configuration ||
              typeof configuration !== 'object' ||
              Array.isArray(configuration) ||
              (configuration.returnImmediately !== undefined &&
                typeof configuration.returnImmediately !== 'boolean'))
          ) {
            error(-32602, 'valid SendMessage configuration required');
            return;
          }
          const message = request.params.message;
          const id = message?.messageId;
          if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || message.role !== 'ROLE_USER') {
            error(-32602, 'valid message identity/role required');
            return;
          }
          if (
            !Array.isArray(message.parts) ||
            message.parts.some((p: unknown) => !p || typeof p !== 'object' || Array.isArray(p))
          ) {
            error(-32602, 'valid structured parts required');
            return;
          }
          const parts = message.parts.filter((p: { data?: unknown }) => p.data !== undefined);
          if (parts.length !== 1) {
            error(-32602, 'exactly one structured assignment required');
            return;
          }
          const existing = records[id];
          if (existing) {
            if (
              existing.assignment &&
              JSON.stringify(existing.assignment) !== JSON.stringify(parts[0].data)
            ) {
              error(-32602, 'messageId reused with different assignment');
              return;
            }
            return existing.task;
          }
          const task: StoredTask = {
            id,
            contextId: String(message.contextId ?? id),
            status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
            artifacts: [],
          };
          let assignment: ExecutionAssignment;
          try {
            assignment = admitExecution(parts[0].data, config);
            if (assignment.assignmentId !== id) throw new Error('assignmentId must match durable messageId');
          } catch (e) {
            status(task, 'TASK_STATE_REJECTED', e instanceof Error ? e.message : 'assignment refused');
            records[id] = { task };
            await persist();
            return task;
          }
          records[id] = { assignment, task };
          status(task, 'TASK_STATE_WORKING');
          await persist();
          const aborter = new AbortController();
          active.set(id, aborter);
          const execute = options.execute ?? ((a, c, signal) => executeAssignment(a, c, undefined, signal));
          void Promise.resolve()
            .then(() => execute(assignment, config, aborter.signal))
            .then(
              (result) =>
                serialize(async () => {
                  if (closed || task.status.state === 'TASK_STATE_CANCELED') return;
                  task.artifacts = executionArtifacts(result);
                  status(task, 'TASK_STATE_COMPLETED');
                  await persist();
                  notify(id);
                }),
              (failure) =>
                serialize(async () => {
                  if (closed || task.status.state === 'TASK_STATE_CANCELED') return;
                  await fs.writeFile(
                    path.join(config.stateDirectory, `${id}.error.log`),
                    failure instanceof Error
                      ? (failure.stack ?? failure.message)
                      : 'unknown execution failure',
                    { mode: 0o600 },
                  );
                  status(task, 'TASK_STATE_FAILED', 'harness execution failed; inspect endpoint-local logs');
                  await persist();
                  notify(id);
                }),
            )
            .finally(() => active.delete(id));
          return task;
        }
        if (request.method === 'GetTask' || request.method === 'CancelTask') {
          const record = records[request.params.id];
          if (!record) {
            error(-32001, 'task not found');
            return;
          }
          if (request.method === 'CancelTask') {
            status(record.task, 'TASK_STATE_CANCELED');
            await persist();
            active.get(record.task.id)?.abort();
            notify(record.task.id);
          }
          return record.task;
        }
        error(-32601, 'method not supported');
      });
      if (!task) return;
      // Never keep the mutation queue locked while waiting for harness completion.
      if (request.method === 'SendMessage' && request.params.configuration?.returnImmediately !== true)
        await waitForTask(task);
      res.json({
        jsonrpc: '2.0',
        id: request.id,
        result: request.method === 'SendMessage' ? { task } : task,
      });
    } catch {
      if (!res.headersSent) error(-32603, 'endpoint storage error');
    }
  });
  let closing: Promise<void> | undefined;
  return {
    baseUrl,
    close: () => {
      if (closing) return closing;
      // Fence synchronously. Drain only admitted mutations, not uncooperative harnesses.
      closed = true;
      for (const controller of active.values()) controller.abort();
      closing = (async () => {
        await serialize(async () => {
          for (const record of Object.values(records)) {
            if (isPending(record.task))
              status(
                record.task,
                'TASK_STATE_FAILED',
                'endpoint closed during execution; no duplicate execution',
              );
          }
          await persist();
          for (const id of waiters.keys()) notify(id);
        });
        await writes;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => server.closeAllConnections(), 1000);
          server.close((e) => {
            clearTimeout(timer);
            e ? reject(e) : resolve();
          });
        });
      })();
      return closing;
    },
  };
}
