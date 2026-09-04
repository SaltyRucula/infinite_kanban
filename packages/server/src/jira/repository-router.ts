import fs from 'node:fs/promises';
import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk';
import type { Project } from '../types.js';
import { errorMessage } from '../utils.js';
import { resolveOpenCodeBaseUrl } from '../opencode/config.js';
import type { JiraIssue } from './client.js';

const MIN_CONFIDENCE = 0.85;
const MAX_README_CHARACTERS = 6_000;

export interface JiraRepositoryRouter {
  route(issue: JiraIssue, projects: readonly Project[]): Promise<string | null>;
}

type RoutingDecision = {
  readonly projectId: string;
  readonly confidence: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDecision(text: string, candidateIds: readonly string[]): RoutingDecision | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[0]);
    if (!isRecord(value)) return null;
    const projectId = value.projectId;
    const confidence = value.confidence;
    if (typeof projectId !== 'string' || !candidateIds.includes(projectId)) return null;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
    return { projectId, confidence };
  } catch {
    return null;
  }
}

async function readProjectBrief(project: Project): Promise<string> {
  if (!project.repoPath) return '';
  try {
    return (await fs.readFile(path.join(project.repoPath, 'README.md'), 'utf8')).slice(0, MAX_README_CHARACTERS);
  } catch {
    return '';
  }
}

export class OpenCodeJiraRepositoryRouter implements JiraRepositoryRouter {
  private readonly activeRoutes = new Map<string, Promise<string | null>>();

  constructor(private readonly baseUrl = resolveOpenCodeBaseUrl()) {}

  async route(issue: JiraIssue, projects: readonly Project[]): Promise<string | null> {
    const active = this.activeRoutes.get(issue.id);
    if (active) return active;
    const route = this.routeIssue(issue, projects).finally(() => this.activeRoutes.delete(issue.id));
    this.activeRoutes.set(issue.id, route);
    return route;
  }

  private async routeIssue(issue: JiraIssue, projects: readonly Project[]): Promise<string | null> {
    if (!this.baseUrl || projects.length === 0) return null;
    try {
      const briefs = await Promise.all(projects.map(async (project) => ({
        id: project.id,
        name: project.name,
        brief: await readProjectBrief(project),
      })));
      const client = createOpencodeClient({ baseUrl: this.baseUrl });
      const session = await client.session.create({ body: { title: `jira-route-${issue.id}` } });
      const sessionId = session.data?.id;
      if (!sessionId) return null;
      try {
        const result = await client.session.prompt({
          path: { id: sessionId },
          body: {
            agent: 'jira-router',
            parts: [{ type: 'text', text: JSON.stringify({ issue, projects: briefs }) }],
          },
        });
        const text = result.data?.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n') ?? '';
        const decision = parseDecision(text, projects.map((project) => project.id));
        return decision && decision.confidence >= MIN_CONFIDENCE ? decision.projectId : null;
      } finally {
        await client.session.delete({ path: { id: sessionId } });
      }
    } catch (error) {
      console.warn(`[jira-router] unable to route issue ${issue.key}: ${errorMessage(error)}`);
      return null;
    }
  }
}
