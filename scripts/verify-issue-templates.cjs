const fs = require('node:fs');
const path = require('node:path');

const templateDir = path.join(__dirname, '..', '.github', 'ISSUE_TEMPLATE');
const requiredFiles = [
  'config.yml',
  'bug-report.yml',
  'feature-request.yml',
  'engineering-task.yml',
];

function readTemplate(filename) {
  const filePath = path.join(templateDir, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing issue-template file: .github/ISSUE_TEMPLATE/${filename}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function requireText(content, filename, expected) {
  if (!content.includes(expected)) {
    throw new Error(`${filename} must include ${JSON.stringify(expected)}`);
  }
}

function requireFormHeader(content, filename) {
  if (!/^name: .+\ndescription: .+\nbody:/m.test(content)) {
    throw new Error(`${filename} must begin with name, description, and body`);
  }
}

for (const filename of requiredFiles) {
  readTemplate(filename);
}

const config = readTemplate('config.yml');
requireText(config, 'config.yml', 'blank_issues_enabled: true');

const bugReport = readTemplate('bug-report.yml');
requireFormHeader(bugReport, 'bug-report.yml');
requireText(bugReport, 'bug-report.yml', 'name: Bug report');
requireText(bugReport, 'bug-report.yml', 'labels: ["bug", "defect"]');
requireText(bugReport, 'bug-report.yml', 'id: reproduction');
requireText(bugReport, 'bug-report.yml', 'id: affected-area');
requireText(bugReport, 'bug-report.yml', 'id: environment');

const featureRequest = readTemplate('feature-request.yml');
requireFormHeader(featureRequest, 'feature-request.yml');
requireText(featureRequest, 'feature-request.yml', 'name: Feature request');
requireText(featureRequest, 'feature-request.yml', 'labels: ["enhancement"]');
requireText(featureRequest, 'feature-request.yml', 'id: problem');
requireText(featureRequest, 'feature-request.yml', 'id: desired-outcome');
requireText(featureRequest, 'feature-request.yml', 'id: alternatives');

const engineeringTask = readTemplate('engineering-task.yml');
requireFormHeader(engineeringTask, 'engineering-task.yml');
requireText(engineeringTask, 'engineering-task.yml', 'name: Engineering task');
requireText(engineeringTask, 'engineering-task.yml', 'id: acceptance-criteria');
requireText(engineeringTask, 'engineering-task.yml', 'id: dependencies');
requireText(engineeringTask, 'engineering-task.yml', 'id: risk');

console.log('Issue template configuration is complete.');
