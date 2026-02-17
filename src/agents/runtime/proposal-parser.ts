export interface ParsedProposal {
  thought: string;
  action: string;
  params: Record<string, unknown>;
  expectedOutcome?: string;
  risk?: string;
  alternativeActions?: string[];
}

export interface ParseProposalResult {
  success: boolean;
  proposal?: ParsedProposal;
  method?: 'masked' | 'repaired';
  error?: string;
}

function collectMaskedCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const push = (value: string | undefined): void => {
    if (!value) return;
    const normalized = value.trim();
    if (!normalized) return;
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  const trimmed = raw.trim();
  push(trimmed);

  const fencedJsonMatches = trimmed.matchAll(/```json\s*([\s\S]*?)\s*```/gi);
  for (const match of fencedJsonMatches) {
    push(match[1]);
  }

  const fencedMatches = trimmed.matchAll(/```\s*([\s\S]*?)\s*```/g);
  for (const match of fencedMatches) {
    push(match[1]);
  }

  // Extract balanced object candidates from noisy text.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          push(trimmed.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  const greedyMatch = trimmed.match(/\{[\s\S]*\}/);
  if (greedyMatch) {
    push(greedyMatch[0]);
  }

  return candidates;
}

function normalizeJsonLikeText(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/，/g, ',')
    .replace(/：/g, ':')
    .replace(/；/g, ';')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function repairJsonCandidate(input: string): string {
  let repaired = normalizeJsonLikeText(input);

  repaired = repaired
    // Remove JS-style comments.
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Quote unquoted keys: { a: 1 } -> { "a": 1 }
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
    // Convert simple single-quoted strings to double-quoted strings.
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, content: string) => {
      const escaped = String(content).replace(/"/g, '\\"');
      return `"${escaped}"`;
    })
    // Remove trailing commas.
    .replace(/,\s*([}\]])/g, '$1')
    .trim();

  return repaired;
}

function parseProposalStrict(input: string): ParsedProposal {
  return JSON.parse(input) as ParsedProposal;
}

export function parseActionProposal(rawOutput: string): ParseProposalResult {
  const candidates = collectMaskedCandidates(rawOutput);
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const parsed = parseProposalStrict(candidate);
      return { success: true, proposal: parsed, method: 'masked' };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`mask parse failed: ${errMsg}`);
    }

    try {
      const repaired = repairJsonCandidate(candidate);
      const parsed = parseProposalStrict(repaired);
      return { success: true, proposal: parsed, method: 'repaired' };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`repair parse failed: ${errMsg}`);
    }
  }

  const error = errors.length > 0
    ? errors.slice(0, 4).join(' | ')
    : 'no parse candidate found from model output';

  return { success: false, error };
}

