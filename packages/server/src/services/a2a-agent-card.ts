export interface NormalizedA2ASkill {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
}

export interface NormalizedA2AAgentCard {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly endpoint: string;
  readonly protocolVersion: string;
  readonly skills: readonly NormalizedA2ASkill[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Agent Card ${field} must be a non-empty string`);
  }
  return value.trim();
}

export function isAllowedA2AUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const hostname = url.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function normalizeSkills(value: unknown): readonly NormalizedA2ASkill[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((skill): readonly NormalizedA2ASkill[] => {
    if (!isRecord(skill) || typeof skill.id !== 'string' || typeof skill.name !== 'string') return [];
    const tags = Array.isArray(skill.tags)
      ? skill.tags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    return [{ id: skill.id, name: skill.name, tags }];
  });
}

/**
 * Validates just the card fields used by the initial curated directory.
 * Board workflow roles and project permissions remain local policy and are
 * intentionally not inferred from an agent's advertised skills.
 */
export function normalizeA2AAgentCard(value: unknown): NormalizedA2AAgentCard {
  if (!isRecord(value)) throw new Error('Agent Card must be an object');

  const name = requiredString(value.name, 'name');
  const description = requiredString(value.description, 'description');
  const version = requiredString(value.version, 'version');
  const interfaces = Array.isArray(value.supportedInterfaces) ? value.supportedInterfaces : [];

  for (const candidate of interfaces) {
    if (!isRecord(candidate) || candidate.protocolBinding !== 'JSONRPC') continue;
    if (typeof candidate.url !== 'string' || typeof candidate.protocolVersion !== 'string') continue;
    let endpoint: URL;
    try {
      endpoint = new URL(candidate.url);
    } catch {
      continue;
    }
    if (!isAllowedA2AUrl(endpoint)) continue;

    return {
      name,
      description,
      version,
      endpoint: endpoint.toString(),
      protocolVersion: candidate.protocolVersion,
      skills: normalizeSkills(value.skills),
    };
  }

  throw new Error('Agent Card does not provide a usable JSON-RPC HTTPS interface');
}
