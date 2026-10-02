import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubIssueClient, type GitHubFetch } from '../src/github/client.js';

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('GitHubIssueClient imports only open issues and follows GitHub pagination', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: GitHubFetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return json([
        {
          id: 101,
          number: 7,
          title: 'Track GitHub issues',
          body: 'Import this issue',
          html_url: 'https://github.com/acme/board/issues/7',
          state: 'open',
          labels: [{ name: 'priority:p1' }, { name: 'area:server' }],
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-02T00:00:00Z',
        },
        {
          id: 102,
          number: 8,
          title: 'Pull request masquerading as an issue',
          html_url: 'https://github.com/acme/board/pull/8',
          state: 'open',
          pull_request: {},
          labels: [],
        },
      ], 200, { link: '<https://api.github.com/repos/acme/board/issues?state=open&per_page=100&page=2>; rel="next"' });
    }
    return json([
      {
        id: 103,
        number: 9,
        title: 'Second issue',
        html_url: 'https://github.com/acme/board/issues/9',
        state: 'open',
        labels: [],
      },
    ]);
  };

  const client = new GitHubIssueClient('https://github.com/acme/board.git', fetcher);
  const issues = await client.listOpenIssues();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/board/issues?state=open&per_page=100&page=1');
  assert.equal(calls[1].url, 'https://api.github.com/repos/acme/board/issues?state=open&per_page=100&page=2');
  assert.equal(new Headers(calls[0].init.headers).get('accept'), 'application/vnd.github+json');
  assert.deepEqual(issues, [
    {
      id: '101', number: 7, title: 'Track GitHub issues', description: 'Import this issue',
      url: 'https://github.com/acme/board/issues/7', labels: ['priority:p1', 'area:server'],
      createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
    },
    {
      id: '103', number: 9, title: 'Second issue', description: '',
      url: 'https://github.com/acme/board/issues/9', labels: [],
      createdAt: undefined, updatedAt: undefined,
    },
  ]);
});

test('GitHubIssueClient rejects non-GitHub repository URLs before making a request', () => {
  assert.throws(
    () => new GitHubIssueClient('https://gitlab.com/acme/board.git'),
    /GitHub repository URL/i,
  );
});
