const DEFAULT_WRAPPER_KEYS = ['input', 'arguments', 'args', 'params', 'payload', 'data', 'value'] as const;
const MAX_MASK_DEPTH = 3;

export function collectMaskedToolInputRecords(rawInput: unknown): Record<string, unknown>[] {
  const visited = new Set<unknown>();
  const records: Record<string, unknown>[] = [];

  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_MASK_DEPTH) return;
    if (visited.has(value)) return;
    visited.add(value);

    const normalized = coerceMaybeJsonObject(value);
    if (!isObjectRecord(normalized)) return;
    records.push(normalized);

    for (const key of DEFAULT_WRAPPER_KEYS) {
      if (!(key in normalized)) continue;
      visit(normalized[key], depth + 1);
    }
  };

  visit(rawInput, 0);
  return records;
}

export function readMaskedString(
  rawInput: unknown,
  keys: string[],
  options: { allowEmpty?: boolean } = {},
): string | undefined {
  for (const record of collectMaskedToolInputRecords(rawInput)) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (options.allowEmpty && value.length >= 0) return value;
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

export function readMaskedNumber(rawInput: unknown, keys: string[]): number | undefined {
  for (const record of collectMaskedToolInputRecords(rawInput)) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return undefined;
}

export function readMaskedBoolean(rawInput: unknown, keys: string[]): boolean | undefined {
  for (const record of collectMaskedToolInputRecords(rawInput)) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
      }
    }
  }
  return undefined;
}

export function readMaskedStringArray(rawInput: unknown, keys: string[]): string[] | undefined {
  for (const record of collectMaskedToolInputRecords(rawInput)) {
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) {
        const normalized = value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        if (normalized.length > 0) return normalized;
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        const normalized = value
          .split(/[\n,|]/)
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        if (normalized.length > 0) return normalized;
      }
    }
  }
  return undefined;
}

export function readMaskedArray(rawInput: unknown, keys: string[]): unknown[] | undefined {
  for (const record of collectMaskedToolInputRecords(rawInput)) {
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) return value;
    }
  }
  return undefined;
}

export function readMaskedRecord(rawInput: unknown, keys: string[]): Record<string, unknown> | undefined {
  for (const record of collectMaskedToolInputRecords(rawInput)) {
    for (const key of keys) {
      const value = record[key];
      if (isObjectRecord(value)) return value;
    }
  }
  return undefined;
}

function coerceMaybeJsonObject(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return value;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isObjectRecord(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
