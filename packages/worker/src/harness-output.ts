/**
 * Locate the structured document in a harness's final message.
 *
 * Settlement is structured-only: the board never accepts prose. But harnesses
 * differ in discipline — OpenCode returns the bare document, Copilot narrates
 * first, Claude fences it — and refusing those outright would make the endpoint
 * compatible with one brand of model rather than with the contract. So the text
 * is searched for a JSON object; the fields inside are still validated strictly
 * by the caller, and a missing or truncated document is an error, never a guess.
 */
export function extractJsonDocument(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [];

  if (trimmed.startsWith('{')) candidates.push(trimmed);

  // ```json … ``` or a bare fence.
  for (const match of trimmed.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)) {
    const fenced = match[1]?.trim();
    if (fenced?.startsWith('{')) candidates.push(fenced);
  }

  // Every balanced top-level object in the text, quote- and escape-aware so a
  // brace inside a string does not end the document early.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const character = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === '{') { if (depth === 0) start = i; depth += 1; continue; }
    if (character === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) { candidates.push(trimmed.slice(start, i + 1)); start = -1; }
      if (depth < 0) depth = 0;
    }
  }

  // Prefer the last well-formed object: a model that restates the requested
  // shape before answering puts its real answer last.
  for (const candidate of candidates.reverse()) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* try the next candidate */ }
  }

  throw new Error('harness did not return a structured JSON object; prose is not a settlement input');
}
