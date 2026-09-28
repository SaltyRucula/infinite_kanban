import { test, expect } from '@playwright/test';
import WebSocket from 'ws';
import { API, deleteTaskViaAPI, registerWorker, startInProcessRun, waitForBoard } from './helpers';

/**
 * E2E tests for the API Improvements (Items 1–5):
 * 1. Single-call task creation + autoRun
 * 2. agent_complete WebSocket event
 * 3. GET /api/tasks/:id/status lightweight endpoint
 * 4. POST /api/tasks/batch endpoint
 * 5. Task result summary events on completion
 */

// ---------------------------------------------------------------------------
// Item 1: Single-call task creation + autoRun
// ---------------------------------------------------------------------------

test.describe('Single-call task creation + autoRun', () => {
  test('POST /api/tasks with all fields creates task with agentType', async ({ request }) => {
    const res = await request.post(`${API}/api/tasks`, {
      data: {
        title: 'API test task',
        description: 'Test creating with extra fields',
        priority: 'high',
        columnId: 'backlog',
        agentType: 'opencode',
      },
    });
    expect(res.status()).toBe(201);
    const task = await res.json();
    expect(task.title).toBe('API test task');
    expect(task.agentType).toBe('opencode');
    expect(task.columnId).toBe('backlog');
    expect(task.agentStatus).toBe('idle');

    // Cleanup
    await deleteTaskViaAPI(request, task.id);
  });

  test('persists a per-task timeout and rejects invalid bounds', async ({ request }) => {
    const created = await request.post(`${API}/api/tasks`, {
      data: { title: 'Long review', timeoutMinutes: 120 },
    });
    expect(created.status()).toBe(201);
    const task = await created.json();
    expect(task.timeoutMinutes).toBe(120);

    const updated = await request.patch(`${API}/api/tasks/${task.id}`, {
      data: { timeoutMinutes: 180 },
    });
    expect(updated.status()).toBe(200);
    expect((await updated.json()).timeoutMinutes).toBe(180);

    const invalid = await request.post(`${API}/api/tasks`, {
      data: { title: 'Invalid timeout', timeoutMinutes: 241 },
    });
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).error).toContain('between 1 and 240');
    await deleteTaskViaAPI(request, task.id);
  });

  test('POST /api/tasks with autoRun=true but columnId=backlog does NOT auto-run', async ({ request }) => {
    const res = await request.post(`${API}/api/tasks`, {
      data: {
        title: 'No auto-run backlog',
        description: 'Should not run because not in-progress',
        columnId: 'backlog',
        autoRun: true,
      },
    });
    expect(res.status()).toBe(201);
    const task = await res.json();
    // Should still be idle since columnId is backlog
    expect(task.agentStatus).toBe('idle');
    expect(task.columnId).toBe('backlog');

    await deleteTaskViaAPI(request, task.id);
  });

  test('POST /api/tasks with autoRun=true does not dispatch without an assigned worker', async ({ request }) => {
    // Board tasks execute on remote workers. Creation cannot assign a worker
    // (assignment goes through POST /api/tasks/:id/assign), so autoRun on its
    // own records no run request and never starts an in-process agent.
    const res = await request.post(`${API}/api/tasks`, {
      data: {
        title: 'Auto-run task',
        description: 'Should not start without a worker',
        columnId: 'in-progress',
        agentType: 'opencode',
        autoRun: true,
      },
    });
    expect(res.status()).toBe(201);
    const task = await res.json();
    expect(task.columnId).toBe('in-progress');
    expect(task.agentStatus).toBe('idle');
    expect(task.runRequestedAt).toBeUndefined();

    await deleteTaskViaAPI(request, task.id);
  });

  test('assigning a registered worker and running dispatches the task to that worker', async ({ request }) => {
    const worker = await registerWorker(request, `autorun-worker-${Date.now()}`);
    const res = await request.post(`${API}/api/tasks`, {
      data: { title: 'Worker dispatch task', columnId: 'in-progress', agentType: 'opencode' },
    });
    const task = await res.json();

    const assign = await request.post(`${API}/api/tasks/${task.id}/assign`, { data: { workerId: worker.id } });
    expect(assign.status()).toBe(200);
    expect((await assign.json()).assignedWorkerId).toBe(worker.id);

    const run = await request.post(`${API}/api/tasks/${task.id}/run`);
    expect(run.status()).toBe(200);
    const running = await run.json();
    expect(running.agentStatus).toBe('planning');
    expect(running.runRequestedAt).toBeDefined();

    const assignments = await request.get(`${API}/api/workers/me/assignments`, {
      headers: { Authorization: `Bearer ${worker.token}` },
    });
    expect(assignments.status()).toBe(200);
    const assigned = (await assignments.json()).tasks as Array<{ id: string }>;
    expect(assigned.map((t) => t.id)).toContain(task.id);

    await deleteTaskViaAPI(request, task.id);
  });

  test('POST /api/tasks with autoRun=false (default) does NOT auto-run', async ({ request }) => {
    const res = await request.post(`${API}/api/tasks`, {
      data: {
        title: 'Explicit no auto-run',
        description: 'autoRun defaults to false',
        columnId: 'in-progress',
      },
    });
    expect(res.status()).toBe(201);
    const task = await res.json();
    expect(task.agentStatus).toBe('idle');

    await deleteTaskViaAPI(request, task.id);
  });

  test('POST /api/tasks validates new fields', async ({ request }) => {
    // Invalid autoRun type
    const res1 = await request.post(`${API}/api/tasks`, {
      data: { title: 'Bad autoRun', autoRun: 'yes' },
    });
    expect(res1.status()).toBe(400);
    const body1 = await res1.json();
    expect(body1.error).toContain('autoRun');

    // Invalid branchName
    const res2 = await request.post(`${API}/api/tasks`, {
      data: { title: 'Bad branch', branchName: '..exploit' },
    });
    expect(res2.status()).toBe(400);
    const body2 = await res2.json();
    expect(body2.error).toContain('branchName');
  });
});

// ---------------------------------------------------------------------------
// Item 3: GET /api/tasks/:id/status
// ---------------------------------------------------------------------------

test.describe('Lightweight status endpoint', () => {
  test('GET /api/tasks/:id/status returns lightweight status', async ({ request }) => {
    // Create a task first
    const createRes = await request.post(`${API}/api/tasks`, {
      data: { title: 'Status test', agentType: 'opencode' },
    });
    const task = await createRes.json();

    const statusRes = await request.get(`${API}/api/tasks/${task.id}/status`);
    expect(statusRes.status()).toBe(200);
    const status = await statusRes.json();

    expect(status.id).toBe(task.id);
    expect(status.agentStatus).toBe('idle');
    expect(status.agentType).toBe('opencode');
    expect(status.columnId).toBe('backlog');
    expect(status.isRunning).toBe(false);

    // Should NOT include heavy fields like title, description, etc.
    expect(status.title).toBeUndefined();
    expect(status.description).toBeUndefined();

    await deleteTaskViaAPI(request, task.id);
  });

  test('GET /api/tasks/:id/status returns 404 for unknown task', async ({ request }) => {
    const res = await request.get(`${API}/api/tasks/nonexistent-id/status`);
    expect(res.status()).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Item 4: POST /api/tasks/batch
// ---------------------------------------------------------------------------

test.describe('Batch create endpoint', () => {
  test('POST /api/tasks/batch creates multiple tasks', async ({ request }) => {
    const res = await request.post(`${API}/api/tasks/batch`, {
      data: {
        tasks: [
          { title: 'Batch A', description: 'First', priority: 'low' },
          { title: 'Batch B', description: 'Second', priority: 'high' },
          { title: 'Batch C', description: 'Third' },
        ],
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.tasks).toHaveLength(3);
    expect(body.tasks[0].title).toBe('Batch A');
    expect(body.tasks[1].title).toBe('Batch B');
    expect(body.tasks[2].title).toBe('Batch C');

    // All should have unique IDs
    const ids = body.tasks.map((t: any) => t.id);
    expect(new Set(ids).size).toBe(3);

    // Cleanup
    for (const t of body.tasks) {
      await deleteTaskViaAPI(request, t.id);
    }
  });

  test('POST /api/tasks/batch validates all tasks before creating any (atomic)', async ({ request }) => {
    // Get current task count
    const beforeRes = await request.get(`${API}/api/tasks`);
    const beforeCount = (await beforeRes.json()).length;

    // Second task has invalid priority — should reject entire batch
    const res = await request.post(`${API}/api/tasks/batch`, {
      data: {
        tasks: [
          { title: 'Valid task' },
          { title: 'Invalid task', priority: 'INVALID' },
        ],
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('task[1]');

    // Verify no tasks were created
    const afterRes = await request.get(`${API}/api/tasks`);
    const afterCount = (await afterRes.json()).length;
    expect(afterCount).toBe(beforeCount);
  });

  test('POST /api/tasks/batch rejects empty array', async ({ request }) => {
    const res = await request.post(`${API}/api/tasks/batch`, {
      data: { tasks: [] },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/tasks/batch rejects non-array', async ({ request }) => {
    const res = await request.post(`${API}/api/tasks/batch`, {
      data: { tasks: 'not-an-array' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/tasks/batch with autoRun creates tasks without dispatching unassigned ones', async ({ request }) => {
    const res = await request.post(`${API}/api/tasks/batch`, {
      data: {
        tasks: [
          {
            title: 'Batch autoRun',
            columnId: 'in-progress',
            agentType: 'opencode',
            autoRun: true,
          },
          {
            title: 'Batch no autoRun',
            columnId: 'backlog',
          },
        ],
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.tasks).toHaveLength(2);

    expect(body.tasks[0].columnId).toBe('in-progress');
    expect(body.tasks[0].agentStatus).toBe('idle');
    expect(body.tasks[0].runRequestedAt).toBeUndefined();
    expect(body.tasks[1].agentStatus).toBe('idle');

    for (const t of body.tasks) {
      await deleteTaskViaAPI(request, t.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Item 2: agent_complete WebSocket event
// ---------------------------------------------------------------------------

test.describe('agent_complete WebSocket event', () => {
  test('receives agent_complete on WS when agent is stopped', async ({ request }) => {
    test.setTimeout(60_000);

    // 1. Connect to WebSocket FIRST so we don't miss the event
    const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    // Collect all agent_complete messages
    const completions: any[] = [];
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'agent_complete') {
        completions.push(msg.payload);
      }
    });

    // 2. Start an in-process run and wait until the agent is live
    const run = await startInProcessRun(request, 'WS complete test');
    const task = { id: run.taskId };
    await expect(async () => {
      const status = await (await request.get(`${API}/api/tasks/${task.id}/status`)).json();
      expect(status.agentStatus).toBe('awaiting_clarification');
    }).toPass({ timeout: 15_000, intervals: [250] });

    // 3. Stop it
    await request.post(`${API}/api/tasks/${task.id}/stop`);

    // 4. Wait for agent_complete to arrive via WS
    await expect(async () => {
      const match = completions.find(c => c.taskId === task.id);
      expect(match).toBeTruthy();
    }).toPass({ timeout: 15_000, intervals: [500] });

    const agentComplete = completions.find(c => c.taskId === task.id);
    expect(agentComplete.taskId).toBe(task.id);
    expect(['complete', 'failed']).toContain(agentComplete.status);
    expect(typeof agentComplete.duration).toBe('number');
    expect(typeof agentComplete.eventCount).toBe('number');

    // Cleanup
    ws.close();
    await run.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Item 5: Summary events in task events
// ---------------------------------------------------------------------------

test.describe('Task result summary events', () => {
  test('events include structured summary with metadata on completion', async ({ request }) => {
    test.setTimeout(60_000);

    // Start an in-process run, wait for it to be live, then stop it to force a clean termination
    const run = await startInProcessRun(request, 'Summary event test');
    const task = { id: run.taskId };
    await expect(async () => {
      const status = await (await request.get(`${API}/api/tasks/${task.id}/status`)).json();
      expect(status.agentStatus).toBe('awaiting_clarification');
    }).toPass({ timeout: 15_000, intervals: [250] });
    await request.post(`${API}/api/tasks/${task.id}/stop`);

    // Wait for agent status to reach a terminal state
    await expect(async () => {
      const statusRes = await request.get(`${API}/api/tasks/${task.id}/status`);
      const status = await statusRes.json();
      expect(['complete', 'failed']).toContain(status.agentStatus);
    }).toPass({ timeout: 15_000, intervals: [500] });

    // Wait for a summary event with metadata.duration to appear (may lag after stop)
    let summaryEvent: any;
    await expect(async () => {
      const eventsRes = await request.get(`${API}/api/tasks/${task.id}/events`);
      const events = await eventsRes.json();
      expect(events.length).toBeGreaterThan(0);
      summaryEvent = events.find(
        (e: any) => (e.type === 'complete' || e.type === 'error') && e.metadata?.duration !== undefined
      );
      expect(summaryEvent).toBeTruthy();
    }).toPass({ timeout: 10_000, intervals: [500] });

    expect(typeof summaryEvent.metadata.duration).toBe('number');
    expect(summaryEvent.metadata.agentType).toBe('opencode');

    // Cleanup
    await run.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Item 6: POST /api/tasks/:id/message — follow-up messages
// ---------------------------------------------------------------------------

test.describe('Follow-up message endpoint', () => {
  test('POST /message returns 404 for unknown task', async ({ request }) => {
    const res = await request.post(`${API}/api/tasks/nonexistent-id/message`, {
      data: { message: 'hello' },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /message returns 400 with empty message', async ({ request }) => {
    // Create a task first
    const createRes = await request.post(`${API}/api/tasks`, {
      data: { title: 'Message validation test' },
    });
    const task = await createRes.json();

    // Empty string
    const res1 = await request.post(`${API}/api/tasks/${task.id}/message`, {
      data: { message: '' },
    });
    expect(res1.status()).toBe(400);
    const body1 = await res1.json();
    expect(body1.error).toContain('message');

    // Missing message field
    const res2 = await request.post(`${API}/api/tasks/${task.id}/message`, {
      data: {},
    });
    expect(res2.status()).toBe(400);

    // Whitespace-only message
    const res3 = await request.post(`${API}/api/tasks/${task.id}/message`, {
      data: { message: '   ' },
    });
    expect(res3.status()).toBe(400);

    await deleteTaskViaAPI(request, task.id);
  });

  test('POST /message returns 409 when no agent is running', async ({ request }) => {
    // Create a task (no agent running)
    const createRes = await request.post(`${API}/api/tasks`, {
      data: { title: 'No agent running test' },
    });
    const task = await createRes.json();

    const res = await request.post(`${API}/api/tasks/${task.id}/message`, {
      data: { message: 'This should fail because no agent is running' },
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('no running agent');

    await deleteTaskViaAPI(request, task.id);
  });
});

// ---------------------------------------------------------------------------
// Existing API backward compatibility
// ---------------------------------------------------------------------------

test.describe('Backward compatibility', () => {
  test('existing POST /api/tasks without new fields works as before', async ({ request }) => {
    const res = await request.post(`${API}/api/tasks`, {
      data: { title: 'Old-style task' },
    });
    expect(res.status()).toBe(201);
    const task = await res.json();
    expect(task.title).toBe('Old-style task');
    expect(task.agentStatus).toBe('idle');
    expect(task.columnId).toBe('backlog');
    expect(task.agentType).toBe('opencode');

    await deleteTaskViaAPI(request, task.id);
  });

  test('existing PATCH, DELETE, events endpoints still work', async ({ request }) => {
    // Create
    const createRes = await request.post(`${API}/api/tasks`, {
      data: { title: 'Compat test' },
    });
    const task = await createRes.json();

    // Patch
    const patchRes = await request.patch(`${API}/api/tasks/${task.id}`, {
      data: { title: 'Updated compat test' },
    });
    expect(patchRes.status()).toBe(200);
    expect((await patchRes.json()).title).toBe('Updated compat test');

    // Events
    const eventsRes = await request.get(`${API}/api/tasks/${task.id}/events`);
    expect(eventsRes.status()).toBe(200);

    // Delete
    const deleteRes = await request.delete(`${API}/api/tasks/${task.id}`);
    expect(deleteRes.status()).toBe(204);
  });

  test('board UI still renders correctly', async ({ page }) => {
    await page.goto('/');
    await waitForBoard(page);
    await expect(page.getByText('Backlog').first()).toBeVisible();
  });
});
