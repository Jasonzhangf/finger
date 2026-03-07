export interface StructuredOutputIssue {
  path: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractJsonCandidate(text: string): string {
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    return text.slice(objectStart, objectEnd + 1);
  }
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return text.slice(arrayStart, arrayEnd + 1);
  }
  return text;
}

function normalizeQuotes(text: string): string {
  return text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, '$1');
}

function appendMissingClosers(text: string): string {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (const ch of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if ((ch === '}' || ch === ']') && stack[stack.length - 1] === ch) stack.pop();
  }
  if (stack.length === 0) return text;
  return `${text}${stack.reverse().join('')}`;
}

export function tryParseStructuredJson(raw: string): {
  parsed?: unknown;
  normalizedText?: string;
  repaired: boolean;
} {
  const attempts = new Map<string, boolean>();
  const candidates = [
    raw.trim(),
    stripMarkdownFence(raw),
    extractJsonCandidate(stripMarkdownFence(raw)),
  ].filter((item) => item.trim().length > 0);

  for (const candidate of candidates) {
    const repairedVariants = [
      candidate,
      normalizeQuotes(candidate),
      stripTrailingCommas(normalizeQuotes(candidate)),
      appendMissingClosers(stripTrailingCommas(normalizeQuotes(candidate))),
    ];
    for (const variant of repairedVariants) {
      const normalized = variant.trim();
      if (!normalized || attempts.has(normalized)) continue;
      attempts.set(normalized, normalized !== raw.trim());
      try {
        return {
          parsed: JSON.parse(normalized),
          normalizedText: normalized,
          repaired: attempts.get(normalized) === true,
        };
      } catch {
        // try next candidate
      }
    }
  }

  return { repaired: false };
}

function expectedTypeMatches(value: unknown, type: string): boolean {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

export function validateStructuredOutput(value: unknown, schema: Record<string, unknown>, path = '$'): StructuredOutputIssue[] {
  const issues: StructuredOutputIssue[] = [];
  const expectedType = typeof schema.type === 'string' ? schema.type : undefined;
  if (expectedType && !expectedTypeMatches(value, expectedType)) {
    issues.push({ path, message: `expected ${expectedType}` });
    return issues;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    issues.push({ path, message: `must be one of: ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}` });
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !Object.is(schema.const, value)) {
    issues.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }

  if (expectedType === 'object' && isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    for (const key of required) {
      if (!(key in value)) {
        issues.push({ path: `${path}.${key}`, message: 'is required' });
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!(key in value) || !isRecord(child)) continue;
      issues.push(...validateStructuredOutput(value[key], child, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          issues.push({ path: `${path}.${key}`, message: 'is not allowed' });
        }
      }
    }
  }

  if (expectedType === 'array' && Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) => {
      issues.push(...validateStructuredOutput(item, schema.items as Record<string, unknown>, `${path}[${index}]`));
    });
  }

  return issues;
}

export function formatStructuredOutputIssues(issues: StructuredOutputIssue[]): string {
  if (issues.length === 0) return 'unknown schema mismatch';
  return issues
    .slice(0, 12)
    .map((issue) => `- ${issue.path}: ${issue.message}`)
    .join('\n');
}

export function normalizeStructuredJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
