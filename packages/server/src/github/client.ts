export interface GitHubIssue {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly labels: readonly string[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function parseRepositoryUrl(repositoryUrl: string): { owner: string; repo: string } {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new Error('A valid GitHub repository URL is required.');
  }

  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password) {
    throw new Error('A valid GitHub repository URL is required.');
  }

  const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('A valid GitHub repository URL is required.');
  }

  return { owner: parts[0], repo: parts[1] };
}

function parseIssue(value: unknown): GitHubIssue | undefined {
  if (!isRecord(value) || 'pull_request' in value) return undefined;

  const id = integer(value.id);
  const number = integer(value.number);
  const title = string(value.title)?.trim();
  const url = string(value.html_url);
  if (id === undefined || number === undefined || !title || !url) return undefined;

  const labels = Array.isArray(value.labels)
    ? value.labels.map((label) => isRecord(label) ? string(label.name) : undefined).filter((label): label is string => Boolean(label))
    : [];

  return {
    id: String(id),
    number,
    title,
    description: string(value.body)?.trim() ?? '',
    url,
    labels,
    createdAt: string(value.created_at),
    updatedAt: string(value.updated_at),
  };
}

export class GitHubIssueClient {
  private readonly apiUrl: string;

  constructor(repositoryUrl: string, private readonly fetcher: GitHubFetch = (url, init) => fetch(url, init)) {
    const { owner, repo } = parseRepositoryUrl(repositoryUrl);
    this.apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
  }

  async listOpenIssues(): Promise<readonly GitHubIssue[]> {
    const issues: GitHubIssue[] = [];
    for (let page = 1; ; page += 1) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.apiUrl}?state=open&per_page=100&page=${page}`, {
          headers: { Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new Error('GitHub request failed.');
      }

      if (!response.ok) {
        throw new Error(response.status === 404 ? 'GitHub repository was not found or is not accessible.' : 'GitHub request failed.');
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error('GitHub returned an invalid response.');
      }
      if (!Array.isArray(payload)) throw new Error('GitHub returned an invalid response.');

      issues.push(...payload.map(parseIssue).filter((issue): issue is GitHubIssue => issue !== undefined));
      if (!response.headers.get('link')?.includes('rel="next"')) return issues;
    }
  }
}
