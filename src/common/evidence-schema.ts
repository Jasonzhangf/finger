export enum EvidenceType {
  Test = 'test',
  Runtime = 'runtime',
  StaticAnalysis = 'static_analysis',
  Screenshot = 'screenshot',
  Log = 'log',
}

const VALID_EVIDENCE_TYPES: ReadonlySet<EvidenceType> = new Set([
  EvidenceType.Test,
  EvidenceType.Runtime,
  EvidenceType.StaticAnalysis,
  EvidenceType.Screenshot,
  EvidenceType.Log,
]);

export interface TypedEvidence {
  type: EvidenceType;
  source: string;
  location?: string;
  result: 'pass' | 'fail' | 'info';
  details: string;
}

export function validateEvidence(evidence: TypedEvidence): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!VALID_EVIDENCE_TYPES.has(evidence.type)) {
    errors.push(`Invalid evidence type: "${evidence.type}"`);
  }
  if (!evidence.source || typeof evidence.source !== 'string' || evidence.source.trim().length === 0) {
    errors.push('Evidence source must be a non-empty string');
  }
  if (evidence.location !== undefined && (typeof evidence.location !== 'string' || evidence.location.trim().length === 0)) {
    errors.push('Evidence location, if provided, must be a non-empty string');
  }
  if (!['pass', 'fail', 'info'].includes(evidence.result)) {
    errors.push(`Invalid evidence result: "${evidence.result}" (expected 'pass', 'fail', or 'info')`);
  }
  if (!evidence.details || typeof evidence.details !== 'string' || evidence.details.trim().length === 0) {
    errors.push('Evidence details must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
}

export function stringToTypedEvidence(input: string): TypedEvidence {
  const trimmed = input.trim();
  return {
    type: EvidenceType.Log,
    source: 'string_conversion',
    result: 'info',
    details: trimmed,
  };
}

export function stringsToTypedEvidence(items: string[]): TypedEvidence[] {
  return items.map((item) => stringToTypedEvidence(item));
}
