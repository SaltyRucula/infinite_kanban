import type { JiraConfig } from './config.js';

export interface JiraIssue {
  readonly id: string;
  readonly key: string;
  readonly summary: string;
  readonly description: string;
  readonly status: string;
  readonly statusCategory?: string;
  readonly issueType: string;
  readonly priorityName?: string;
  readonly projectKey?: string;
  readonly projectName?: string;
  readonly created?: string;
  readonly updated?: string;
  readonly labels?: readonly string[];
  readonly components?: readonly string[];
}

interface JiraSearchPage {
  readonly startAt: number;
  readonly total: number;
  readonly receivedCount: number;
  readonly issues: readonly JiraIssue[];
}

export type JiraFetch = (url: string, init: RequestInit) => Promise<Response>;

export class JiraClientError extends Error {
  constructor(
    readonly code: 'auth' | 'upstream' | 'invalid_response',
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

const SEARCH_PATH = '/rest/api/2/search';
const PAGE_SIZE = 100;
const ASSIGNED_ISSUES_JQL = 'assignee = currentUser() AND statusCategory in ("To Do", "In Progress") ORDER BY updated DESC';
const REQUEST_FIELDS = ['summary', 'status', 'priority', 'issuetype', 'description', 'project', 'created', 'updated', 'labels', 'components'] as const;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function readNamedField(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return readString(value.name);
}

function readNamedFields(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(readNamedField)
    .filter((item): item is string => item !== undefined);
}

function readStringFields(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(readString)
    .filter((item): item is string => item !== undefined);
}

function flattenDescription(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';

  const chunks: string[] = [];
  const walk = (node: unknown): void => {
    if (!isRecord(node)) return;
    const nodeType = readString(node.type);
    const text = readString(node.text);
    if (text) chunks.push(text);
    if (nodeType === 'hardBreak') chunks.push('\n');

    const content = node.content;
    if (Array.isArray(content)) {
      for (const child of content) walk(child);
      if (nodeType === 'paragraph' || nodeType === 'heading' || nodeType === 'listItem') {
        chunks.push('\n');
      }
    }
  };

  walk(value);
  return chunks.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function parseIssue(value: unknown): JiraIssue | undefined {
  if (!isRecord(value)) return undefined;

  const id = readString(value.id);
  const key = readString(value.key);
  if (!id || !key) return undefined;

  const fields = isRecord(value.fields) ? value.fields : {};
  const summary = readString(fields.summary)?.trim() ?? '';
  const description = flattenDescription(fields.description);
  const statusValue = isRecord(fields.status) ? fields.status : undefined;

  const projectValue = isRecord(fields.project) ? fields.project : undefined;

  return {
    id,
    key,
    summary,
    description,
    status: readString(statusValue?.name) ?? 'Unknown',
    statusCategory: isRecord(statusValue?.statusCategory) ? readString(statusValue.statusCategory.key) : undefined,
    issueType: readNamedField(fields.issuetype) ?? 'Unknown',
    priorityName: readNamedField(fields.priority),
    projectKey: projectValue ? readString(projectValue.key) : undefined,
    projectName: projectValue ? readString(projectValue.name) : undefined,
    created: readString(fields.created),
    updated: readString(fields.updated),
    labels: readStringFields(fields.labels),
    components: readNamedFields(fields.components),
  };
}

function parseSearchPage(payload: unknown): JiraSearchPage {
  if (!isRecord(payload)) {
    throw new JiraClientError('invalid_response', 'Jira response must be a JSON object.');
  }

  const startAt = readInteger(payload.startAt);
  const total = readInteger(payload.total);
  if (startAt === undefined || startAt < 0 || total === undefined || total < 0) {
    throw new JiraClientError('invalid_response', 'Jira response is missing pagination metadata.');
  }

  if (!Array.isArray(payload.issues)) {
    throw new JiraClientError('invalid_response', 'Jira response is missing issues array.');
  }

  const parsedIssues = payload.issues
    .map(parseIssue)
    .filter((issue): issue is JiraIssue => issue !== undefined);

  return {
    startAt,
    total,
    receivedCount: payload.issues.length,
    issues: parsedIssues,
  };
}

function buildAuthHeader(config: JiraConfig): string {
  if (config.isDataCenter) {
    return `Bearer ${config.apiToken}`;
  }

  const basicToken = Buffer.from(`${config.userEmail}:${config.apiToken}`, 'utf8').toString('base64');
  return `Basic ${basicToken}`;
}

export class JiraRestClient {
  private readonly searchUrl: string;
  private readonly authHeader: string;

  constructor(
    config: JiraConfig,
    private readonly fetcher: JiraFetch = (url, init) => fetch(url, init),
  ) {
    this.searchUrl = `${config.normalizedBaseUrl}${SEARCH_PATH}`;
    this.authHeader = buildAuthHeader(config);
  }

  async listAssignedIssues(): Promise<readonly JiraIssue[]> {
    const issues: JiraIssue[] = [];
    let startAt = 0;
    let total = Number.POSITIVE_INFINITY;

    while (startAt < total) {
      const page = await this.fetchSearchPage(startAt);
      issues.push(...page.issues.filter((issue) => issue.statusCategory !== 'done'));
      total = page.total;

      if (page.receivedCount === 0) break;
      const nextStartAt = page.startAt + page.receivedCount;
      if (nextStartAt <= startAt) break;
      startAt = nextStartAt;
    }

    return issues;
  }

  private async fetchSearchPage(startAt: number): Promise<JiraSearchPage> {
    let response: Response;
    try {
      response = await this.fetcher(this.searchUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': this.authHeader,
        },
        body: JSON.stringify({
          jql: ASSIGNED_ISSUES_JQL,
          startAt,
          maxResults: PAGE_SIZE,
          fields: REQUEST_FIELDS,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (error instanceof JiraClientError) throw error;
      throw new JiraClientError('upstream', 'Jira request failed.');
    }

    if (response.status === 401 || response.status === 403) {
      throw new JiraClientError('auth', 'Jira authentication failed.', response.status);
    }
    if (!response.ok) {
      throw new JiraClientError('upstream', `Jira request failed with status ${response.status}.`, response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new JiraClientError('invalid_response', 'Jira response is not valid JSON.', response.status);
    }

    return parseSearchPage(payload);
  }
}
