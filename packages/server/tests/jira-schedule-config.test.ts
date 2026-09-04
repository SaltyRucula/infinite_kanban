import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_JIRA_IMPORT_ENABLED,
  DEFAULT_JIRA_IMPORT_INTERVAL_MINUTES,
  MAX_JIRA_IMPORT_INTERVAL_MINUTES,
  MIN_JIRA_IMPORT_INTERVAL_MINUTES,
  isValidJiraImportEnabled,
  isValidJiraImportIntervalMinutes,
  parseJiraImportSchedule,
} from '../src/jira/schedule-config.js';

test('Jira schedule constants keep imports disabled with a fifteen minute default', () => {
  assert.equal(DEFAULT_JIRA_IMPORT_ENABLED, false);
  assert.equal(DEFAULT_JIRA_IMPORT_INTERVAL_MINUTES, 15);
  assert.equal(MIN_JIRA_IMPORT_INTERVAL_MINUTES, 5);
  assert.equal(MAX_JIRA_IMPORT_INTERVAL_MINUTES, 1440);
});

test('Jira schedule validators reject coercible and out-of-range values', () => {
  assert.equal(isValidJiraImportEnabled(true), true);
  assert.equal(isValidJiraImportEnabled('true'), false);
  assert.equal(isValidJiraImportIntervalMinutes(5), true);
  assert.equal(isValidJiraImportIntervalMinutes(1440), true);
  assert.equal(isValidJiraImportIntervalMinutes(4), false);
  assert.equal(isValidJiraImportIntervalMinutes(15.5), false);
  assert.equal(isValidJiraImportIntervalMinutes('15'), false);
});

test('Jira schedule parser accepts settings and nullable run metadata', () => {
  const parsed = parseJiraImportSchedule({
    jiraImportEnabled: true,
    jiraImportIntervalMinutes: 30,
    jiraImportLastRunAt: 100,
    jiraImportLastCompletedAt: null,
    jiraImportLastError: null,
    jiraImportLastTotal: 4,
  }, true);
  assert.deepEqual(parsed, {
    jiraImportEnabled: true,
    jiraImportIntervalMinutes: 30,
    jiraImportLastRunAt: 100,
    jiraImportLastCompletedAt: null,
    jiraImportLastError: null,
    jiraImportLastTotal: 4,
  });
});

test('Jira schedule parser rejects invalid metadata and null settings', () => {
  assert.equal(
    parseJiraImportSchedule({ jiraImportEnabled: null }, true),
    'jiraImportEnabled must be a boolean',
  );
  assert.match(
    String(parseJiraImportSchedule({ jiraImportLastCreated: 1.5 }, true)),
    /non-negative integer/,
  );
  assert.equal(
    parseJiraImportSchedule({ jiraImportLastError: null }, false),
    'jiraImportLastError must be a string',
  );
});
