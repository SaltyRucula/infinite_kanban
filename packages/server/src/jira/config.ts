export interface JiraConfig {
  readonly baseUrl: string;
  readonly normalizedBaseUrl: string;
  readonly userEmail?: string;
  readonly apiToken: string;
  readonly isDataCenter: boolean;
}

export type JiraConfigResolution =
  | { readonly configured: true; readonly config: JiraConfig }
  | { readonly configured: false; readonly reason: string };

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function readTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isDataCenterEnabled(raw: string | undefined): boolean {
  return raw ? TRUE_VALUES.has(raw.trim().toLowerCase()) : false;
}

export function normalizeJiraBaseUrl(rawBaseUrl: string): string {
  const url = new URL(rawBaseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('JIRA_BASE_URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('JIRA_BASE_URL must not include credentials, query parameters, or fragments');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

export function resolveJiraConfig(env: NodeJS.ProcessEnv = process.env): JiraConfigResolution {
  const isDataCenter = isDataCenterEnabled(env.JIRA_IS_DATACENTER);
  const baseUrl = readTrimmed(env.JIRA_BASE_URL);
  const apiToken = readTrimmed(env.JIRA_API_TOKEN);
  const userEmail = readTrimmed(env.JIRA_USER_EMAIL);

  const missing: string[] = [];
  if (!baseUrl) missing.push('JIRA_BASE_URL');
  if (!apiToken) missing.push('JIRA_API_TOKEN');
  if (!isDataCenter && !userEmail) missing.push('JIRA_USER_EMAIL');

  if (missing.length > 0) {
    return {
      configured: false,
      reason: `Jira import is not configured. Missing ${missing.join(', ')}.`,
    };
  }

  if (!baseUrl || !apiToken) {
    return {
      configured: false,
      reason: 'Jira import is not configured. Missing JIRA_BASE_URL, JIRA_API_TOKEN.',
    };
  }

  try {
    const normalizedBaseUrl = normalizeJiraBaseUrl(baseUrl);
    return {
      configured: true,
      config: {
        baseUrl,
        normalizedBaseUrl,
        userEmail,
        apiToken,
        isDataCenter,
      },
    };
  } catch (error) {
    if (error instanceof Error) {
      return {
        configured: false,
        reason: 'Jira import is not configured. JIRA_BASE_URL must be a valid absolute URL.',
      };
    }
    throw error;
  }
}
