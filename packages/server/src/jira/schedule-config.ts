export const DEFAULT_JIRA_IMPORT_ENABLED = false;
export const DEFAULT_JIRA_IMPORT_INTERVAL_MINUTES = 15;
export const MIN_JIRA_IMPORT_INTERVAL_MINUTES = 5;
export const MAX_JIRA_IMPORT_INTERVAL_MINUTES = 1440;

export interface ParsedJiraImportSchedule {
  jiraImportEnabled?: boolean;
  jiraImportIntervalMinutes?: number;
  jiraImportAutoStart?: boolean;
  jiraImportLastRunAt?: number | null;
  jiraImportLastCompletedAt?: number | null;
  jiraImportLastSuccessAt?: number | null;
  jiraImportLastError?: string | null;
  jiraImportLastTotal?: number | null;
  jiraImportLastCreated?: number | null;
  jiraImportLastSkipped?: number | null;
}

export interface ParsedJiraImportCreateSchedule {
  jiraImportEnabled?: boolean;
  jiraImportIntervalMinutes?: number;
  jiraImportAutoStart?: boolean;
}

export function isValidJiraImportEnabled(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function isValidJiraImportIntervalMinutes(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_JIRA_IMPORT_INTERVAL_MINUTES
    && value <= MAX_JIRA_IMPORT_INTERVAL_MINUTES;
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isValidCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function parseJiraImportSchedule(
  body: Record<string, unknown>,
  allowNullMetadata: boolean,
): ParsedJiraImportSchedule | string {
  const out: ParsedJiraImportSchedule = {};
  if ('jiraImportEnabled' in body && body.jiraImportEnabled !== undefined) {
    if (!isValidJiraImportEnabled(body.jiraImportEnabled)) return 'jiraImportEnabled must be a boolean';
    out.jiraImportEnabled = body.jiraImportEnabled;
  }
  if ('jiraImportIntervalMinutes' in body && body.jiraImportIntervalMinutes !== undefined) {
    if (!isValidJiraImportIntervalMinutes(body.jiraImportIntervalMinutes)) {
      return `jiraImportIntervalMinutes must be an integer between ${MIN_JIRA_IMPORT_INTERVAL_MINUTES} and ${MAX_JIRA_IMPORT_INTERVAL_MINUTES}`;
    }
    out.jiraImportIntervalMinutes = body.jiraImportIntervalMinutes;
  }

  const timestamps = [
    ['jiraImportLastRunAt', 'jiraImportLastRunAt'],
    ['jiraImportLastCompletedAt', 'jiraImportLastCompletedAt'],
    ['jiraImportLastSuccessAt', 'jiraImportLastSuccessAt'],
  ] as const;
  for (const [key, outputKey] of timestamps) {
    if (!(key in body) || body[key] === undefined) continue;
    if (body[key] === null) {
      if (!allowNullMetadata) return `${key} must be a non-negative integer`;
      out[outputKey] = null;
      continue;
    }
    if (!isValidTimestamp(body[key])) return `${key} must be a non-negative integer or null`;
    out[outputKey] = body[key];
  }

  if ('jiraImportLastError' in body && body.jiraImportLastError !== undefined) {
    if (body.jiraImportLastError === null) {
      if (!allowNullMetadata) return 'jiraImportLastError must be a string';
      out.jiraImportLastError = null;
    } else if (typeof body.jiraImportLastError !== 'string') {
      return 'jiraImportLastError must be a string or null';
    } else {
      out.jiraImportLastError = body.jiraImportLastError;
    }
  }

  const counts = [
    ['jiraImportLastTotal', 'jiraImportLastTotal'],
    ['jiraImportLastCreated', 'jiraImportLastCreated'],
    ['jiraImportLastSkipped', 'jiraImportLastSkipped'],
  ] as const;
  for (const [key, outputKey] of counts) {
    if (!(key in body) || body[key] === undefined) continue;
    if (body[key] === null) {
      if (!allowNullMetadata) return `${key} must be a non-negative integer`;
      out[outputKey] = null;
      continue;
    }
    if (!isValidCount(body[key])) return `${key} must be a non-negative integer or null`;
    out[outputKey] = body[key];
  }

  if ('jiraImportAutoStart' in body && body.jiraImportAutoStart !== undefined) {
    if (typeof body.jiraImportAutoStart !== 'boolean') return 'jiraImportAutoStart must be a boolean';
    out.jiraImportAutoStart = body.jiraImportAutoStart;
  }

  return out;
}

export function parseJiraImportCreateSchedule(body: Record<string, unknown>): ParsedJiraImportCreateSchedule | string {
  const parsed = parseJiraImportSchedule(body, false);
  if (typeof parsed === 'string') return parsed;
  return {
    ...(parsed.jiraImportEnabled === undefined ? {} : { jiraImportEnabled: parsed.jiraImportEnabled }),
    ...(parsed.jiraImportIntervalMinutes === undefined ? {} : { jiraImportIntervalMinutes: parsed.jiraImportIntervalMinutes }),
    ...(parsed.jiraImportAutoStart === undefined ? {} : { jiraImportAutoStart: parsed.jiraImportAutoStart }),
  };
}
