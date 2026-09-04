import assert from 'node:assert/strict';
import test from 'node:test';
import { JiraRestClient, JiraClientError, type JiraFetch } from '../src/jira/client.js';
import type { JiraConfig } from '../src/jira/config.js';

function makeConfig(overrides: Partial<JiraConfig> = {}): JiraConfig {
  return {
    baseUrl: 'https://jira.example.com',
    normalizedBaseUrl: 'https://jira.example.com',
    userEmail: 'user@example.com',
    apiToken: 'token-value',
    isDataCenter: false,
    ...overrides,
  };
}

function makeJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('JiraRestClient paginates Data Center search responses and flattens descriptions', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: JiraFetch = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(String(init.body)) as { startAt: number };
    if (body.startAt === 0) {
      return makeJsonResponse({
        startAt: 0,
        maxResults: 100,
        total: 3,
        issues: [
          {
            id: '1001',
            key: 'PROJ-1',
            fields: {
              summary: 'First issue',
              description: {
                type: 'doc',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }, { type: 'hardBreak' }, { type: 'text', text: 'World' }] }],
              },
               status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
              priority: { name: 'High' },
              issuetype: { name: 'Bug' },
              project: { key: 'PROJ', name: 'Project' },
              labels: ['Intvis.Tellurium'],
              components: [{ name: 'Tellurium' }],
              created: '2026-08-10T01:02:03.000+0000',
              updated: '2026-08-10T01:03:04.000+0000',
            },
          },
          {
            id: '1002',
            key: 'PROJ-2',
            fields: {
              summary: 'Second issue',
              description: 'plain text description',
               status: { name: 'To Do', statusCategory: { key: 'new' } },
              issuetype: { name: 'Task' },
            },
          },
        ],
      });
    }

    return makeJsonResponse({
      startAt: 2,
      maxResults: 100,
      total: 3,
      issues: [
        {
          id: '1003',
          key: 'PROJ-3',
          fields: {
            summary: 'Third issue',
            description: null,
            status: { name: 'Done', statusCategory: { key: 'done' } },
            issuetype: { name: 'Story' },
          },
        },
      ],
    });
  };

  const client = new JiraRestClient(makeConfig({ isDataCenter: true, userEmail: undefined }), fetcher);
  const issues = await client.listAssignedIssues();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://jira.example.com/rest/api/2/search');
  assert.equal(calls[1].url, 'https://jira.example.com/rest/api/2/search');

  assert.equal(calls[0].init.method, 'POST');
  const firstBody = JSON.parse(String(calls[0].init.body)) as { jql: string; startAt: number; fields: string[] };
   assert.equal(firstBody.jql, 'assignee = currentUser() AND statusCategory in ("To Do", "In Progress") ORDER BY updated DESC');
  assert.equal(firstBody.startAt, 0);
  assert.deepEqual(firstBody.fields, ['summary', 'status', 'priority', 'issuetype', 'description', 'project', 'created', 'updated', 'labels', 'components']);

  const auth = new Headers(calls[0].init.headers).get('authorization');
  assert.equal(auth, 'Bearer token-value');

   assert.equal(issues.length, 2);
  assert.equal(issues[0].description, 'Hello\nWorld');
  assert.deepEqual(issues[0].labels, ['Intvis.Tellurium']);
  assert.deepEqual(issues[0].components, ['Tellurium']);
  assert.equal(issues[1].description, 'plain text description');
});

test('JiraRestClient uses Basic auth in non-Data Center mode', async () => {
  const calls: RequestInit[] = [];
  const fetcher: JiraFetch = async (_url, init) => {
    calls.push(init);
    return makeJsonResponse({ startAt: 0, total: 0, issues: [] });
  };

  const client = new JiraRestClient(makeConfig(), fetcher);
  await client.listAssignedIssues();

  assert.equal(calls.length, 1);
  const auth = new Headers(calls[0].headers).get('authorization');
  assert.ok(auth?.startsWith('Basic '));
});

test('JiraRestClient classifies auth and invalid-response failures', async () => {
  const authFailureClient = new JiraRestClient(makeConfig(), async () => new Response('forbidden', { status: 403 }));
  await assert.rejects(authFailureClient.listAssignedIssues(), (err: unknown) => err instanceof JiraClientError && err.code === 'auth');

  const invalidPayloadClient = new JiraRestClient(makeConfig(), async () => makeJsonResponse({ startAt: 0, total: 1, issues: 'bad' }));
  await assert.rejects(invalidPayloadClient.listAssignedIssues(), (err: unknown) => err instanceof JiraClientError && err.code === 'invalid_response');
});
