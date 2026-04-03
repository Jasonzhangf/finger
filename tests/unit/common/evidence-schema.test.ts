import { describe, expect, it } from 'vitest';
import {
  EvidenceType,
  type TypedEvidence,
  stringToTypedEvidence,
  stringsToTypedEvidence,
  validateEvidence,
} from '../../../src/common/evidence-schema.js';

describe('evidence-schema', () => {
  describe('EvidenceType enum', () => {
    it('has all required type values', () => {
      expect(EvidenceType.Test).toBe('test');
      expect(EvidenceType.Runtime).toBe('runtime');
      expect(EvidenceType.StaticAnalysis).toBe('static_analysis');
      expect(EvidenceType.Screenshot).toBe('screenshot');
      expect(EvidenceType.Log).toBe('log');
    });
  });

  describe('validateEvidence', () => {
    it('accepts a valid evidence with all fields', () => {
      const evidence: TypedEvidence = {
        type: EvidenceType.Test,
        source: 'vitest',
        location: 'src/foo.test.ts:42',
        result: 'pass',
        details: 'all 10 test cases passed',
      };
      expect(validateEvidence(evidence)).toEqual({ valid: true, errors: [] });
    });

    it('accepts evidence without optional location', () => {
      const evidence: TypedEvidence = {
        type: EvidenceType.Runtime,
        source: 'cli',
        result: 'fail',
        details: 'exit code 1',
      };
      expect(validateEvidence(evidence)).toEqual({ valid: true, errors: [] });
    });

    it('rejects invalid type', () => {
      const evidence = {
        type: 'unknown_type',
        source: 'vitest',
        result: 'pass' as const,
        details: 'ok',
      };
      const result = validateEvidence(evidence as TypedEvidence);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([expect.stringContaining('Invalid evidence type')]);
    });

    it('rejects empty source', () => {
      const evidence = {
        type: EvidenceType.Log,
        source: '',
        result: 'info' as const,
        details: 'some log',
      };
      const result = validateEvidence(evidence as TypedEvidence);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([expect.stringContaining('source must be a non-empty string')]);
    });

    it('rejects empty location when provided', () => {
      const evidence = {
        type: EvidenceType.Log,
        source: 'test',
        location: '   ',
        result: 'info' as const,
        details: 'some log',
      };
      const result = validateEvidence(evidence as TypedEvidence);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([expect.stringContaining('location')]);
    });

    it('rejects invalid result', () => {
      const evidence = {
        type: EvidenceType.Test,
        source: 'vitest',
        result: 'skipped',
        details: 'ok',
      };
      const result = validateEvidence(evidence as TypedEvidence);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([expect.stringContaining('Invalid evidence result')]);
    });

    it('rejects empty details', () => {
      const evidence = {
        type: EvidenceType.Log,
        source: 'test',
        result: 'info' as const,
        details: '',
      };
      const result = validateEvidence(evidence as TypedEvidence);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([expect.stringContaining('details must be a non-empty string')]);
    });

    it('collects multiple errors at once', () => {
      const evidence = {
        type: 'bogus',
        source: '',
        result: 'bad',
        details: '',
      };
      const result = validateEvidence(evidence as TypedEvidence);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('stringToTypedEvidence', () => {
    it('converts a plain string to TypedEvidence with Log type', () => {
      const result = stringToTypedEvidence('file-a.ts');
      expect(result.type).toBe(EvidenceType.Log);
      expect(result.source).toBe('string_conversion');
      expect(result.result).toBe('info');
      expect(result.details).toBe('file-a.ts');
      expect(result.location).toBeUndefined();
    });

    it('trims whitespace from input', () => {
      const result = stringToTypedEvidence('  spaced content  ');
      expect(result.details).toBe('spaced content');
    });
  });

  describe('stringsToTypedEvidence', () => {
    it('converts an array of strings', () => {
      const result = stringsToTypedEvidence(['a.ts', 'b.ts']);
      expect(result).toHaveLength(2);
      expect(result[0].details).toBe('a.ts');
      expect(result[1].details).toBe('b.ts');
    });

    it('returns empty array for empty input', () => {
      expect(stringsToTypedEvidence([])).toEqual([]);
    });
  });
});
