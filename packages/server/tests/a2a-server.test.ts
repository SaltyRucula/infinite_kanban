import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import { createA2ARouter } from '../src/a2a/router.ts';
import type { Project } from '../src/types.js';
import type { Task } from '../src/types.js';

type Json = Record<string, unknown>;

function project(): Project {
  return {
    id: 'project-1',
    name: 'board',
    repoPath: '/repos/board',
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
    defaultBaseBranch: 'main',
    jiraImportEnabled: false,
    jiraImportIntervalMinutes: 15,
    jiraImportAutoStart: false,
  };
}

function createFakes() {
  const tasks = new Map<string, Task>();
  const started: string[] = [];
  const stopped: string[] = [];
  const resumed: Array<{ taskId: string; requestId: string; sessionId: string; answer: string }> = [];
  const taskRepo = {
    getById: async (id: string) => tasks.get(id),
    // Mirrors the real repository: project-scoped, defaulting to `default`.
    // A store that calls this without a project id sees nothing, which is the
    // bug this fake exists to catch.
    getAll: async (includeArchived = false, projectId = 'default') => [...tasks.values()]
      .filter((task) => task.projectId === projectId)
      .filter((task) => includeArchived || !task.archived),
    createIdempotent: async (task: Task) => {
      const existing = [...tasks.values()].find((candidate) => candidate.externalKey === task.externalKey
        && candidate.externalSource === task.externalSource);
      if (existing) return { task: existing, created: false };
      tasks.set(task.id, task);
      return { task, created: true };
    },
    update: async (id: string, updates: Partial<Task>) => {
      const current = tasks.get(id);
      if (!current) return undefined;
      const next = { ...current, ...updates };
      tasks.set(id, next);
      return next;
    },
    claimRun: async (id: string) => { started.push(id); return tasks.get(id); },
    requestRun: async (id: string) => tasks.get(id),
  } as unknown as Parameters<typeof createA2ARouter>[0]['taskRepo'];

  const projectRepo = {
    resolve: async (reference: string) => (reference === 'board' || reference === 'project-1'
      ? [project()]
      : reference === 'ambiguous' ? [project(), { ...project(), id: 'project-2' }] : []),
    getById: async (id: string) => (id === 'project-1' ? project() : undefined),
    getAllWithCounts: async () => [project()],
  } as unknown as Parameters<typeof createA2ARouter>[0]['projectRepo'];

  const agents = {
    getAvailableAgents: () => [{ name: 'opencode', displayName: 'OpenCode', available: true }],
    sendMessage: async (taskId: string) => tasks.get(taskId)?.agentStatus === 'executing',
    resumeClarification: async (taskId: string, input: { requestId: string; sessionId: string; answer: string }) => {
      resumed.push({ taskId, ...input });
      return { ok: true, code: 'resumed', message: 'clarification accepted' };
    },
    stopAgent: async (taskId: string) => { stopped.push(taskId); return true; },
    isRunning: () => false,
  } as unknown as Parameters<typeof createA2ARouter>[0]['agents'];

  return { tasks, started, stopped, resumed, taskRepo, projectRepo, agents };
}

async function withBoard(
  run: (ctx: { url: string; rpc: (method: string, params: Json, id?: string) => Promise<Json>; fakes: ReturnType<typeof createFakes> }) => Promise<void>,
): Promise<void> {
  const context = createFakes();
  const app = express();
  app.use(express.json());
  app.use('/', createA2ARouter({
    taskRepo: context.taskRepo,
    projectRepo: context.projectRepo,
    agents: context.agents,
    boardVersion: '9.9.9',
    publicUrl: 'https://board.example.test',
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const rpc = async (method: string, params: Json, id = `rpc-${method}`): Promise<Json> => {
    const response = await fetch(`${url}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    return await response.json() as Json;
  };
  try {
    await run({ url, rpc, fakes: context });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('the board serves an Agent Card describing what it can be asked to do', async () => {
  await withBoard(async ({ url }) => {
    const response = await fetch(`${url}/.well-known/agent-card.json`);
    assert.equal(response.status, 200);
    const card = await response.json() as Json;
    assert.equal(card.name, 'Infinite Kanban Board');
    assert.equal(card.version, '9.9.9');
    const interfaces = card.supportedInterfaces as Array<{ url: string; protocolBinding: string; protocolVersion: string }>;
    assert.deepEqual(interfaces.map((item) => item.protocolBinding), ['JSONRPC', 'HTTP+JSON']);
    for (const item of interfaces) {
      assert.equal(item.url, 'https://board.example.test/a2a/v1');
      assert.equal(item.protocolVersion, '1.0');
    }
    const skills = card.skills as Array<{ id: string }>;
    assert.deepEqual(skills.map((skill) => skill.id), ['code-task', 'code-review', 'task-group']);
  });
});

test('SendMessage creates a board task and reports it as an A2A task', async () => {
  await withBoard(async ({ rpc, fakes: context }) => {
    const sent = await rpc('SendMessage', {
      message: {
        messageId: 'msg-create-1',
        role: 'ROLE_USER',
        parts: [{ text: 'Add rate limiting\n\nThe worker event endpoint accepts unbounded traffic.' }],
        metadata: { project: 'board', autoStart: false },
      },
    });
    const task = ((sent.result as Json)?.task ?? {}) as Json;
    assert.ok(task.id, `no task returned: ${JSON.stringify(sent)}`);
    assert.equal((task.status as Json).state, 'TASK_STATE_SUBMITTED');
    assert.equal(context.tasks.size, 1);

    const created = [...context.tasks.values()][0];
    assert.equal(created.title, 'Add rate limiting');
    assert.equal(created.projectId, 'project-1');
    assert.equal(created.externalSource, 'a2a');
    assert.equal(created.externalKey, 'msg-create-1');
    assert.equal(created.useWorktree, true);
    // The repository path is board-side policy resolved from the project.
    assert.equal(created.repoPath, '/repos/board');

    const contract = (task.metadata as Json)[
      'https://github.com/SaltyRucula/infinite_kanban/a2a/board/v1#taskContract'
    ] as Json;
    assert.equal(contract.projectId, 'project-1');
    assert.equal(contract.deepLink, `https://board.example.test/projects/project-1/tasks/${String(task.id)}`);
    assert.equal('repoPath' in contract, false);
    assert.equal('worktreePath' in contract, false);
  });
});

test('a replayed messageId returns the same task instead of duplicating work', async () => {
  await withBoard(async ({ rpc, fakes: context }) => {
    const params = {
      message: {
        messageId: 'msg-replay-1',
        role: 'ROLE_USER',
        parts: [{ text: 'Add rate limiting' }],
        metadata: { project: 'board', autoStart: false },
      },
    };
    const first = await rpc('SendMessage', params, 'rpc-1');
    const second = await rpc('SendMessage', params, 'rpc-2');
    assert.equal(((first.result as Json).task as Json).id, ((second.result as Json).task as Json).id);
    assert.equal(context.tasks.size, 1);
  });
});

test('SendMessage resumes a board clarification on the same A2A task', async () => {
  await withBoard(async ({ rpc, fakes: context }) => {
    const created = await rpc('SendMessage', {
      message: {
        messageId: 'msg-clarification-create',
        role: 'ROLE_USER',
        parts: [{ text: 'Add rate limiting' }],
        metadata: { project: 'board', autoStart: false },
      },
    });
    const taskId = String(((created.result as Json).task as Json).id);
    const pending = context.tasks.get(taskId);
    assert.ok(pending);
    context.tasks.set(taskId, {
      ...pending,
      agentStatus: 'awaiting_clarification',
      columnId: 'pending',
      clarificationRequest: {
        requestId: 'question-1',
        sessionId: 'session-1',
        prompt: 'Which branch should I target?',
        choices: ['main'],
        timestamp: 2,
      },
    });

    const resumed = await rpc('SendMessage', {
      message: {
        messageId: 'msg-clarification-answer',
        taskId,
        contextId: `task-${taskId}`,
        role: 'ROLE_USER',
        parts: [{ text: 'main' }],
      },
    });

    assert.ok((resumed.result as Json).task, `resume failed: ${JSON.stringify(resumed)}`);
    assert.deepEqual(context.resumed, [{
      taskId,
      requestId: 'question-1',
      sessionId: 'session-1',
      answer: 'main',
    }]);
  });
});

test('GetTask, ListTasks and CancelTask operate on the board task', async () => {
  await withBoard(async ({ rpc, fakes: context }) => {
    const created = await rpc('SendMessage', {
      message: {
        messageId: 'msg-lifecycle-1',
        role: 'ROLE_USER',
        parts: [{ text: 'Add rate limiting' }],
        metadata: { project: 'board', autoStart: false },
      },
    });
    const taskId = String(((created.result as Json).task as Json).id);

    const fetched = await rpc('GetTask', { id: taskId });
    assert.equal((fetched.result as Json).id, taskId);

    const listed = await rpc('ListTasks', {});
    const list = listed.result as { tasks: Json[]; totalSize: number; nextPageToken: string };
    // The board's repository is project-scoped and defaults to the `default`
    // project, so a store that lists without walking projects reports nothing.
    assert.equal(list.totalSize, 1);
    assert.equal(list.tasks.length, 1);
    assert.equal((list.tasks[0] as Json).id, taskId);
    assert.equal(list.nextPageToken, '');

    const canceled = await rpc('CancelTask', { id: taskId });
    assert.ok(canceled.result, `cancel failed: ${JSON.stringify(canceled)}`);
    assert.equal(((canceled.result as Json).status as Json).state, 'TASK_STATE_CANCELED');
    assert.equal((canceled.result as Json).id, taskId);
    assert.deepEqual(context.stopped, [taskId]);

    const missing = await rpc('GetTask', { id: 'does-not-exist' });
    assert.ok(missing.error, 'expected a JSON-RPC error for an unknown task');
  });
});

test('the board refuses work it cannot place, and malformed requests', async () => {
  await withBoard(async ({ rpc, fakes }) => {
    const rejected = await rpc('SendMessage', {
      message: {
        messageId: 'msg-reject-1',
        role: 'ROLE_USER',
        parts: [{ text: 'Do something' }],
        metadata: { project: 'nope', autoStart: false },
      },
    });
    assert.equal((((rejected.result as Json).task as Json).status as Json).state, 'TASK_STATE_REJECTED');

    const ambiguous = await rpc('SendMessage', {
      message: {
        messageId: 'msg-reject-2',
        role: 'ROLE_USER',
        parts: [{ text: 'Do something' }],
        metadata: { project: 'ambiguous', autoStart: false },
      },
    }, 'rpc-ambiguous');
    assert.equal((((ambiguous.result as Json).task as Json).status as Json).state, 'TASK_STATE_REJECTED');

    const malformed = await rpc('SendMessage', {
      message: {
        messageId: 'msg-bad-1',
        role: 'ROLE_USER',
        parts: [{ text: 'Do something' }],
        metadata: { project: 'board', repoPath: '/etc/passwd' },
      },
    }, 'rpc-malformed');
    // A peer-supplied host path is refused: the task terminates and the reason
    // names the offending field, so the caller can fix its request.
    const failed = (malformed.result as Json).task as Json;
    assert.equal((failed.status as Json).state, 'TASK_STATE_FAILED');
    assert.match(JSON.stringify((failed.status as Json).message), /repoPath/);
    // Nothing was placed on the board for any of the three refusals.
    assert.equal(fakes.tasks.size, 0);
  });
});

test('the REST binding serves the same operations', async () => {
  await withBoard(async ({ url }) => {
    const sent = await fetch(`${url}/a2a/v1/message:send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({
        message: {
          messageId: 'msg-rest-1',
          role: 'ROLE_USER',
          parts: [{ text: 'Add rate limiting' }],
          metadata: { project: 'board', autoStart: false },
        },
      }),
    });
    assert.equal(sent.status, 200);
    const body = await sent.json() as Json;
    const task = (body.task ?? body) as Json;
    assert.ok(task.id, `no task in REST response: ${JSON.stringify(body)}`);

    const fetched = await fetch(`${url}/a2a/v1/tasks/${String(task.id)}`, { headers: { 'A2A-Version': '1.0' } });
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json() as Json).id, task.id);
  });
});

test('a configured service token is required and must carry a2a:send', async () => {
  process.env.SERVICE_TOKENS = JSON.stringify([
    { token: 'sender-token', scopes: ['a2a:send'] },
    { token: 'reader-token', scopes: ['projects:read'] },
  ]);
  try {
    await withBoard(async ({ url }) => {
      const card = await fetch(`${url}/.well-known/agent-card.json`);
      const body = await card.json() as Json;
      assert.ok((body.securitySchemes as Json).bearer, 'card must advertise bearer auth when tokens are configured');

      const send = async (token?: string): Promise<number> => {
        const response = await fetch(`${url}/a2a/v1`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'A2A-Version': '1.0',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'auth-1',
            method: 'SendMessage',
            params: {
              message: {
                messageId: `msg-auth-${token ?? 'none'}`,
                role: 'ROLE_USER',
                parts: [{ text: 'Add rate limiting' }],
                metadata: { project: 'board', autoStart: false },
              },
            },
          }),
        });
        return response.status;
      };

      assert.notEqual(await send(), 200);
      assert.notEqual(await send('reader-token'), 200);
      assert.equal(await send('sender-token'), 200);
    });
  } finally {
    delete process.env.SERVICE_TOKENS;
  }
});
