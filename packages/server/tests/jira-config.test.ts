import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeJiraBaseUrl, resolveJiraConfig } from '../src/jira/config.js';

test('resolveJiraConfig requires base url, token, and email for non-Data Center mode', () => {
  const missingAll = resolveJiraConfig({});
  assert.equal(missingAll.configured, false);
  if (missingAll.configured) return;
  assert.match(missingAll.reason, /JIRA_BASE_URL/);
  assert.match(missingAll.reason, /JIRA_API_TOKEN/);
  assert.match(missingAll.reason, /JIRA_USER_EMAIL/);

  const configured = resolveJiraConfig({
    JIRA_BASE_URL: 'https://jira.example.com/',
    JIRA_API_TOKEN: 'token-value',
    JIRA_USER_EMAIL: 'user@example.com',
  });
  assert.equal(configured.configured, true);
  if (!configured.configured) return;
  assert.equal(configured.config.isDataCenter, false);
  assert.equal(configured.config.normalizedBaseUrl, 'https://jira.example.com');
});

test('resolveJiraConfig supports Data Center bearer mode without user email', () => {
  const configured = resolveJiraConfig({
    JIRA_BASE_URL: 'https://jira.dc.example.com/jira',
    JIRA_API_TOKEN: 'dc-token',
    JIRA_IS_DATACENTER: 'true',
  });

  assert.equal(configured.configured, true);
  if (!configured.configured) return;
  assert.equal(configured.config.isDataCenter, true);
  assert.equal(configured.config.userEmail, undefined);
  assert.equal(configured.config.normalizedBaseUrl, 'https://jira.dc.example.com/jira');
});

test('normalizeJiraBaseUrl strips trailing slash', () => {
  assert.equal(
    normalizeJiraBaseUrl('https://jira.example.com/path/'),
    'https://jira.example.com/path',
  );
});

test('normalizeJiraBaseUrl rejects credentials and URL decorations', () => {
  assert.throws(
    () => normalizeJiraBaseUrl('https://user:secret@jira.example.com/jira?token=leak#fragment'),
    /must not include credentials/,
  );
});

test('resolveJiraConfig rejects invalid base url', () => {
  const result = resolveJiraConfig({
    JIRA_BASE_URL: 'not-a-url',
    JIRA_API_TOKEN: 'token-value',
    JIRA_USER_EMAIL: 'user@example.com',
  });

  assert.equal(result.configured, false);
  if (result.configured) return;
  assert.match(result.reason, /valid absolute URL/);
});
