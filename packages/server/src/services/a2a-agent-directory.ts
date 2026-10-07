import {
  isAllowedA2AUrl,
  normalizeA2AAgentCard,
  type NormalizedA2AAgentCard,
} from './a2a-agent-card.js';

export type A2AAgentCardFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Retrieves an Agent Card from a user-configured trusted URL. This performs no
 * network scanning or trust inference: the caller owns registration and
 * project/role policy after card validation succeeds.
 */
export async function fetchA2AAgentCard(
  agentCardUrl: string,
  fetcher: A2AAgentCardFetch = (url, init) => fetch(url, init),
): Promise<NormalizedA2AAgentCard> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(agentCardUrl);
  } catch {
    throw new Error('Agent Card URL must be an absolute URL');
  }
  if (!isAllowedA2AUrl(parsedUrl)) {
    throw new Error('Agent Card URL must use HTTPS or loopback HTTP');
  }

  const response = await fetcher(parsedUrl.toString(), {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Agent Card fetch failed with HTTP ${response.status}`);
  }

  let card: unknown;
  try {
    card = await response.json();
  } catch {
    throw new Error('Agent Card response must contain JSON');
  }
  return normalizeA2AAgentCard(card);
}
