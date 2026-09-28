import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import { API, prepareTestRepo } from './helpers';

// ─── Helpers ────────────────────────────────────────────────────────

async function deleteGroup(request: APIRequestContext, id: string) {
  await request.delete(`${API}/api/groups/${id}`).catch(() => {});
}

function makeChildren(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Child task ${i + 1}`,
    description: `Description for child ${i + 1}`,
    agentType: 'opencode',
    useWorktree: false,
  }));
}

// ─── API Tests ──────────────────────────────────────────────────────

test.describe('Task Groups API', () => {
  const createdGroupIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdGroupIds) {
      await deleteGroup(request, id);
    }
    createdGroupIds.length = 0;
  });

  test('POST /api/groups creates a group with children', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'E2E Test Group',
        description: 'Testing group creation',
        priority: 'high',
        maxConcurrency: 2,
        children: makeChildren(3),
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdGroupIds.push(body.id);

    expect(body.title).toBe('E2E Test Group');
    expect(body.description).toBe('Testing group creation');
    expect(body.priority).toBe('high');
    expect(body.maxConcurrency).toBe(2);
    expect(body.columnId).toBe('backlog');
    expect(body.children).toHaveLength(3);
    expect(body.children[0].title).toBe('Child task 1');
    expect(body.children[0].groupId).toBe(body.id);
    expect(body.children[0].groupOrder).toBe(0);
    expect(body.children[1].groupOrder).toBe(1);
    expect(body.children[2].groupOrder).toBe(2);
  });

  test('GET /api/groups lists all groups with children', async ({ request }) => {
    // Create a group
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'List Test Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    // List groups
    const listRes = await request.get(`${API}/api/groups`);
    expect(listRes.status()).toBe(200);
    const groups = await listRes.json();
    const found = groups.find((g: any) => g.id === group.id);
    expect(found).toBeDefined();
    expect(found.children).toHaveLength(2);
  });

  test('GET /api/groups/:id returns group with children', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Get By ID Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    const getRes = await request.get(`${API}/api/groups/${group.id}`);
    expect(getRes.status()).toBe(200);
    const body = await getRes.json();
    expect(body.id).toBe(group.id);
    expect(body.title).toBe('Get By ID Group');
    expect(body.children).toHaveLength(2);
  });

  test('PATCH /api/groups/:id updates group metadata', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Original Title',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    const patchRes = await request.patch(`${API}/api/groups/${group.id}`, {
      data: { title: 'Updated Title', priority: 'critical' },
    });
    expect(patchRes.status()).toBe(200);
    const updated = await patchRes.json();
    expect(updated.title).toBe('Updated Title');
    expect(updated.priority).toBe('critical');
  });

  test('DELETE /api/groups/:id deletes group and cascades children', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Delete Test Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    const childId = group.children[0].id;

    // Delete the group
    const delRes = await request.delete(`${API}/api/groups/${group.id}`);
    expect(delRes.status()).toBe(204);

    // Group should be gone
    const getRes = await request.get(`${API}/api/groups/${group.id}`);
    expect(getRes.status()).toBe(404);

    // Child tasks should be gone too (cascade)
    const childRes = await request.get(`${API}/api/tasks/${childId}`);
    expect(childRes.status()).toBe(404);
  });

  test('grouped children are excluded from GET /api/tasks', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Exclusion Test Group',
        maxConcurrency: 1,
        children: [{ title: 'Hidden Child', agentType: 'opencode' }],
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    // Main tasks list should NOT contain the child
    const tasksRes = await request.get(`${API}/api/tasks`);
    const tasks = await tasksRes.json();
    const childInList = tasks.find((t: any) => t.title === 'Hidden Child');
    expect(childInList).toBeUndefined();
  });

  test('POST /api/groups rejects fewer than 2 children', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Too Few Children',
        maxConcurrency: 1,
        children: [{ title: 'Only one', agentType: 'opencode' }],
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('at least');
  });

  test('POST /api/groups rejects missing title', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/groups rejects child with missing title', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Valid Group Title',
        maxConcurrency: 1,
        children: [
          { title: 'Valid child', agentType: 'opencode' },
          { description: 'No title here', agentType: 'opencode' },
        ],
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('children[1]');
  });

  test('POST /api/groups rejects invalid maxConcurrency', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Bad Concurrency',
        maxConcurrency: 0,
        children: makeChildren(2),
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxConcurrency');
  });

  test('POST /api/groups rejects maxConcurrency > children count', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Too Much Concurrency',
        maxConcurrency: 5,
        children: makeChildren(2),
      },
    });
    expect(res.status()).toBe(400);
  });

  test('children inherit group-level branch config', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Config Inheritance Group',
        baseBranch: 'develop',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdGroupIds.push(body.id);

    expect(body.children[0].baseBranch).toBe('develop');
    expect(body.children[1].baseBranch).toBe('develop');
  });

  test('children keep the supported agent type and reject unsupported ones', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'OpenCode Group',
        maxConcurrency: 2,
        children: [
          { title: 'Explicit OpenCode task', agentType: 'opencode' },
          { title: 'Default agent task' },
        ],
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdGroupIds.push(body.id);

    expect(body.children[0].agentType).toBe('opencode');
    expect(body.children[1].agentType).toBe('opencode');

    // OpenCode is the only supported execution engine; legacy providers are rejected.
    const legacy = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Legacy Agent Group',
        maxConcurrency: 1,
        children: [
          { title: 'Legacy task', agentType: 'claude' },
          { title: 'Other task', agentType: 'opencode' },
        ],
      },
    });
    expect(legacy.status()).toBe(400);
    expect((await legacy.json()).error).toContain('agentType');
  });

  test('PATCH /api/groups/:id/archive archives group and children', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Archive Test Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    const archiveRes = await request.patch(`${API}/api/groups/${group.id}/archive`);
    expect(archiveRes.status()).toBe(200);

    // Group should not appear in non-archived list
    const listRes = await request.get(`${API}/api/groups`);
    const groups = await listRes.json();
    const found = groups.find((g: any) => g.id === group.id);
    expect(found).toBeUndefined();
  });

  test('PATCH /api/groups/:id/unarchive restores group to backlog', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Unarchive Test Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    // Archive then unarchive
    await request.patch(`${API}/api/groups/${group.id}/archive`);
    const unarchiveRes = await request.patch(`${API}/api/groups/${group.id}/unarchive`);
    expect(unarchiveRes.status()).toBe(200);
    const restored = await unarchiveRes.json();
    expect(restored.columnId).toBe('backlog');
    expect(restored.archived).toBeFalsy();
  });

  test('E3: PATCH columnId=backlog resets children to idle', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Reset Test Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    // Simulate moving to in-progress (without running agents)
    await request.patch(`${API}/api/groups/${group.id}`, {
      data: { columnId: 'in-progress' },
    });

    // Move back to backlog — should reset children
    const resetRes = await request.patch(`${API}/api/groups/${group.id}`, {
      data: { columnId: 'backlog' },
    });
    expect(resetRes.status()).toBe(200);
    const reset = await resetRes.json();
    expect(reset.columnId).toBe('backlog');
    for (const child of reset.children) {
      expect(child.agentStatus).toBe('idle');
    }
  });

  test('E12: POST /api/groups/:id/run returns 409 if already running', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Conflict Test Group',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    // First run
    const runRes = await request.post(`${API}/api/groups/${group.id}/run`);
    // May succeed or fail depending on agent availability — just need it to start the queue
    if (runRes.status() === 200) {
      // Second run should be rejected (409 conflict or 429 rate limited)
      const conflictRes = await request.post(`${API}/api/groups/${group.id}/run`);
      expect([409, 429]).toContain(conflictRes.status());
      // Clean up
      await request.post(`${API}/api/groups/${group.id}/stop`);
    }
  });

  test('GET /api/groups/:id returns 404 for unknown group', async ({ request }) => {
    const res = await request.get(`${API}/api/groups/nonexistent-id`);
    expect(res.status()).toBe(404);
  });

  test('POST /api/groups/:id/run returns 404 for unknown group', async ({ request }) => {
    const res = await request.post(`${API}/api/groups/nonexistent-id/run`);
    expect(res.status()).toBe(404);
  });

  test('POST /api/groups/:id/stop returns 404 for unknown group', async ({ request }) => {
    const res = await request.post(`${API}/api/groups/nonexistent-id/stop`);
    expect(res.status()).toBe(404);
  });

  test('POST /api/groups rejects non-string child description', async ({ request }) => {
    const res = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Bad Description Group',
        maxConcurrency: 1,
        children: [
          { title: 'Valid child', agentType: 'opencode' },
          { title: 'Bad child', description: 123, agentType: 'opencode' },
        ],
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('children[1].description');
  });

  test('PATCH /api/groups/:id rejects invalid maxConcurrency', async ({ request }) => {
    const createRes = await request.post(`${API}/api/groups`, {
      data: {
        title: 'Concurrency Patch Test',
        maxConcurrency: 1,
        children: makeChildren(2),
      },
    });
    const group = await createRes.json();
    createdGroupIds.push(group.id);

    // Zero
    const res0 = await request.patch(`${API}/api/groups/${group.id}`, { data: { maxConcurrency: 0 } });
    expect(res0.status()).toBe(400);

    // Greater than children count
    const resHigh = await request.patch(`${API}/api/groups/${group.id}`, { data: { maxConcurrency: 99 } });
    expect(resHigh.status()).toBe(400);

    // Non-integer
    const resFloat = await request.patch(`${API}/api/groups/${group.id}`, { data: { maxConcurrency: 1.5 } });
    expect(resFloat.status()).toBe(400);

    // Valid update should work
    const resOk = await request.patch(`${API}/api/groups/${group.id}`, { data: { maxConcurrency: 2 } });
    expect(resOk.status()).toBe(200);
    const updated = await resOk.json();
    expect(updated.maxConcurrency).toBe(2);
  });
});

// ─── UI ─────────────────────────────────────────────────────────────
// The Worker Operations Console (root view) does not surface task groups or
// the group creation dialog, so the former board-level group UI specs were
// removed. Group behavior stays covered through the API specs above.
