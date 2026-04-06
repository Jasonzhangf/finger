import { describe, expect, it } from 'vitest';
import { AgentPath, ValidationError } from '../../../src/common/agent-path.js';

describe('AgentPath', () => {
  // ============ root() ============
  describe('root()', () => {
    it('returns "/root"', () => {
      const p = AgentPath.root();
      expect(p.toString()).toBe('/root');
    });

    it('isRoot() returns true', () => {
 expect(AgentPath.root().isRoot()).toBe(true);
    });

    it('depth() returns 0', () => {
      expect(AgentPath.root().depth()).toBe(0);
    });

    it('name() returns "root"', () => {
      expect(AgentPath.root().name()).toBe('root');
    });

    it('parent() returns null', () => {
      expect(AgentPath.root().parent()).toBeNull();
    });
  });

  // ============ fromString() ============
  describe('fromString()', () => {
    it('accepts "/root"', () => {
      const p = AgentPath.fromString('/root');
      expect(p.toString()).toBe('/root');
    });

    it('accepts "/root/worker"', () => {
      const p = AgentPath.fromString('/root/worker');
      expect(p.toString()).toBe('/root/worker');
    });

    it('accepts "/root/worker/sub"', () => {
      const p = AgentPath.fromString('/root/worker/sub');
      expect(p.toString()).toBe('/root/worker/sub');
    });

    it('accepts deep paths', () => {
      const p = AgentPath.fromString('/root/a/b/c/d');
      expect(p.toString()).toBe('/root/a/b/c/d');
      expect(p.depth()).toBe(4);
    });

    it('accepts segments with digits and underscores', () => {
      const p = AgentPath.fromString('/root/agent_01/test_2');
      expect(p.toString()).toBe('/root/agent_01/test_2');
    });

    it('throws ValidationError for empty string', () => {
      expect(() => AgentPath.fromString('')).toThrow(ValidationError);
    });

    it('throws ValidationError for "/invalid"', () => {
      expect(() => AgentPath.fromString('/invalid')).toThrow(ValidationError);
    });

    it('throws ValidationError for "/root/Invalid" (uppercase)', () => {
      expect(() => AgentPath.fromString('/root/Invalid')).toThrow(ValidationError);
    });

    it('throws ValidationError for "/root/.."', () => {
      expect(() => AgentPath.fromString('/root/..')).toThrow(ValidationError);
    });

    it('throws ValidationError for "/root/.', () => {
      expect(() => AgentPath.fromString('/root/.')).toThrow(ValidationError);
    });

    it('throws ValidationError for "/root/" (trailing slash)', () => {
      expect(() => AgentPath.fromString('/root/')).toThrow(ValidationError);
    });

    it('throws ValidationError for "root" (missing leading slash)', () => {
      expect(() => AgentPath.fromString('root')).toThrow(ValidationError);
    });

    it('throws ValidationError for segment starting with digit', () => {
      expect(() => AgentPath.fromString('/root/1abc')).toThrow(ValidationError);
    });

    it('throws ValidationError for segment with hyphen', () => {
      expect(() => AgentPath.fromString('/root/my-agent')).toThrow(ValidationError);
    });

    it('throws ValidationError for "/root/root" (reserved name)', () => {
      expect(() => AgentPath.fromString('/root/root')).toThrow(ValidationError);
    });
  });

  // ============ tryFromString() ============
  describe('tryFromString()', () => {
    it('returns AgentPath for valid input', () => {
      const p = AgentPath.tryFromString('/root/worker');
      expect(p).not.toBeNull();
      expect(p!.toString()).toBe('/root/worker');
    });

    it('returns null for invalid input', () => {
      expect(AgentPath.tryFromString('')).toBeNull();
      expect(AgentPath.tryFromString('/invalid')).toBeNull();
      expect(AgentPath.tryFromString('/root/..')).toBeNull();
    });

    it('returns AgentPath for "/root"', () => {
      const p = AgentPath.tryFromString('/root');
      expect(p).not.toBeNull();
      expect(p!.isRoot()).toBe(true);
    });
  });

  // ============ fromSegments() ============
  describe('fromSegments()', () => {
    it('returns "/root" for no segments', () => {
      const p = AgentPath.fromSegments();
      expect(p.toString()).toBe('/root');
    });

    it('returns "/root/a" for one segment', () => {
      const p = AgentPath.fromSegments('a');
      expect(p.toString()).toBe('/root/a');
    });

    it('returns "/root/a/b" for two segments', () => {
      const p = AgentPath.fromSegments('a', 'b');
      expect(p.toString()).toBe('/root/a/b');
    });

    it('returns deep paths for many segments', () => {
      const p = AgentPath.fromSegments('a', 'b', 'c', 'd', 'e');
      expect(p.toString()).toBe('/root/a/b/c/d/e');
    });

    it('throws ValidationError for "Invalid"', () => {
      expect(() => AgentPath.fromSegments('Invalid')).toThrow(ValidationError);
    });

    it('throws ValidationError for "root"', () => {
      expect(() => AgentPath.fromSegments('root')).toThrow(ValidationError);
    });

    it('throws ValidationError for ".."', () => {
      expect(() => AgentPath.fromSegments('..')).toThrow(ValidationError);
    });

    it('throws ValidationError for "."', () => {
      expect(() => AgentPath.fromSegments('.')).toThrow(ValidationError);
    });

    it('throws ValidationError for empty string segment', () => {
      expect(() => AgentPath.fromSegments('')).toThrow(ValidationError);
    });

    it('throws ValidationError for segment starting with digit', () => {
      expect(() => AgentPath.fromSegments('1abc')).toThrow(ValidationError);
    });
  });

  // ============ name() ============
  describe('name()', () => {
    it('returns "root" for root path', () => {
      expect(AgentPath.root().name()).toBe('root');
    });

    it('returns last segment', () => {
      expect(AgentPath.fromString('/root/worker').name()).toBe('worker');
    });

    it('returns last segment of deep path', () => {
      expect(AgentPath.fromString('/root/a/b/c').name()).toBe('c');
    });
  });

  // ============ parent() ============
  describe('parent()', () => {
    it('returns null for root', () => {
      expect(AgentPath.root().parent()).toBeNull();
    });

    it('returns root for "/root/worker"', () => {
      const parent = AgentPath.fromString('/root/worker').parent();
      expect(parent).not.toBeNull();
      expect(parent!.toString()).toBe('/root');
    });

    it('returns "/root/a" for "/root/a/b"', () => {
      const parent = AgentPath.fromString('/root/a/b').parent();
      expect(parent).not.toBeNull();
      expect(parent!.toString()).toBe('/root/a');
    });

    it('chains parent() calls correctly', () => {
      const p = AgentPath.fromString('/root/a/b/c');
      expect(p.parent()!.toString()).toBe('/root/a/b');
      expect(p.parent()!.parent()!.toString()).toBe('/root/a');
      expect(p.parent()!.parent()!.parent()!.toString()).toBe('/root');
      expect(p.parent()!.parent()!.parent()!.parent()).toBeNull();
    });
  });

  // ============ join() ============
  describe('join()', () => {
    it('joins child to root', () => {
      const p = AgentPath.root().join('worker');
      expect(p.toString()).toBe('/root/worker');
    });

    it('joins child to non-root path', () => {
      const p = AgentPath.fromString('/root/a').join('b');
      expect(p.toString()).toBe('/root/a/b');
    });

    it('chains joins', () => {
      const p = AgentPath.root().join('a').join('b').join('c');
      expect(p.toString()).toBe('/root/a/b/c');
    });

    it('throws ValidationError for "Invalid"', () => {
      expect(() => AgentPath.root().join('Invalid')).toThrow(ValidationError);
    });

    it('throws ValidationError for ".."', () => {
      expect(() => AgentPath.root().join('..')).toThrow(ValidationError);
    });

    it('throws ValidationError for "root"', () => {
      expect(() => AgentPath.root().join('root')).toThrow(ValidationError);
    });

    it('throws ValidationError for segment starting with digit', () => {
      expect(() => AgentPath.root().join('1abc')).toThrow(ValidationError);
    });
  });

  // ============ resolve() ============
  describe('resolve()', () => {
    it('resolves "./child" correctly', () => {
      const p = AgentPath.fromString('/root/worker');
      const resolved = p.resolve('./child');
      expect(resolved.toString()).toBe('/root/worker/child');
    });

    it('resolves "../sibling" correctly', () => {
      const p = AgentPath.fromString('/root/worker');
      const resolved = p.resolve('../sibling');
      expect(resolved.toString()).toBe('/root/sibling');
    });

    it('resolves "sibling" as current-level sibling', () => {
      // "sibling" with no prefix: goes to parent, then adds sibling
      // This is treated as a regular segment added to current path
      const p = AgentPath.fromString('/root/worker');
      const resolved = p.resolve('sibling');
      expect(resolved.toString()).toBe('/root/worker/sibling');
    });

    it('resolves absolute path "/root/absolute"', () => {
      const p = AgentPath.fromString('/root/worker/sub');
      const resolved = p.resolve('/root/absolute');
      expect(resolved.toString()).toBe('/root/absolute');
    });

    it('resolves "../.." to go up two levels', () => {
      const p = AgentPath.fromString('/root/a/b');
      const resolved = p.resolve('../..');
      expect(resolved.toString()).toBe('/root');
    });

    it('resolves "../../c" correctly', () => {
      const p = AgentPath.fromString('/root/a/b');
      const resolved = p.resolve('../../c');
      expect(resolved.toString()).toBe('/root/c');
    });

    it('resolves from root with "./child"', () => {
      const p = AgentPath.root();
      const resolved = p.resolve('./child');
      expect(resolved.toString()).toBe('/root/child');
    });

    it('resolves multiple segments correctly', () => {
      const p = AgentPath.fromString('/root/a');
      const resolved = p.resolve('./b/c');
      expect(resolved.toString()).toBe('/root/a/b/c');
    });

    it('throws ValidationError for ".." from root (would go above root)', () => {
      const p = AgentPath.root();
      expect(() => p.resolve('..')).toThrow(ValidationError);
    });

    it('throws ValidationError for "../../.." going above root', () => {
      const p = AgentPath.fromString('/root/a');
      expect(() => p.resolve('../../..')).toThrow(ValidationError);
    });

    it('throws ValidationError for invalid absolute path', () => {
      const p = AgentPath.fromString('/root/a');
      expect(() => p.resolve('/invalid')).toThrow(ValidationError);
    });

    it('throws ValidationError for invalid segment in reference', () => {
      const p = AgentPath.fromString('/root/a');
      expect(() => p.resolve('./Invalid')).toThrow(ValidationError);
    });

    it('resolves ".." from depth 1 back to root', () => {
      const p = AgentPath.fromString('/root/worker');
      const resolved = p.resolve('..');
      expect(resolved.toString()).toBe('/root');
    });

    it('resolves ".." from root throws', () => {
      const p = AgentPath.root();
      expect(() => p.resolve('..')).toThrow(ValidationError);
    });
  });

  // ============ isValid() ============
  describe('isValid()', () => {
    it('returns true for "/root"', () => {
      expect(AgentPath.isValid('/root')).toBe(true);
    });

    it('returns true for "/root/worker"', () => {
      expect(AgentPath.isValid('/root/worker')).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(AgentPath.isValid('')).toBe(false);
    });

    it('returns false for "/invalid"', () => {
      expect(AgentPath.isValid('/invalid')).toBe(false);
    });

    it('returns false for "root" (no leading slash)', () => {
      expect(AgentPath.isValid('root')).toBe(false);
    });

    it('returns false for "/root/.."', () => {
      expect(AgentPath.isValid('/root/..')).toBe(false);
    });

    it('returns false for "/root/Upper"', () => {
      expect(AgentPath.isValid('/root/Upper')).toBe(false);
    });

    it('returns false for "/root/"', () => {
      expect(AgentPath.isValid('/root/')).toBe(false);
    });
  });

  // ============ isValidSegment() ============
  describe('isValidSegment()', () => {
    it('returns true for valid segments', () => {
      expect(AgentPath.isValidSegment('worker')).toBe(true);
      expect(AgentPath.isValidSegment('a')).toBe(true);
      expect(AgentPath.isValidSegment('test_01')).toBe(true);
      expect(AgentPath.isValidSegment('abc123')).toBe(true);
    });

    it('returns false for reserved names', () => {
      expect(AgentPath.isValidSegment('root')).toBe(false);
      expect(AgentPath.isValidSegment('.')).toBe(false);
      expect(AgentPath.isValidSegment('..')).toBe(false);
      expect(AgentPath.isValidSegment('')).toBe(false);
    });

    it('returns false for uppercase', () => {
      expect(AgentPath.isValidSegment('Invalid')).toBe(false);
      expect(AgentPath.isValidSegment('A')).toBe(false);
    });

    it('returns false for segment starting with digit', () => {
      expect(AgentPath.isValidSegment('1abc')).toBe(false);
    });

    it('returns false for segment with hyphen', () => {
      expect(AgentPath.isValidSegment('my-agent')).toBe(false);
    });

    it('returns false for segment too long', () => {
      const longSegment = 'a'.repeat(65);
      expect(AgentPath.isValidSegment(longSegment)).toBe(false);
    });

    it('returns true for segment at max length (64)', () => {
      const segment = 'a'.repeat(64);
      expect(AgentPath.isValidSegment(segment)).toBe(true);
    });

    it('returns false for segment with spaces', () => {
      expect(AgentPath.isValidSegment('my agent')).toBe(false);
    });
  });

  // ============ depth() ============
  describe('depth()', () => {
    it('returns 0 for root', () => {
      expect(AgentPath.root().depth()).toBe(0);
    });

    it('returns 1 for "/root/a"', () => {
      expect(AgentPath.fromString('/root/a').depth()).toBe(1);
    });

    it('returns 2 for "/root/a/b"', () => {
      expect(AgentPath.fromString('/root/a/b').depth()).toBe(2);
    });

    it('returns 3 for "/root/a/b/c"', () => {
      expect(AgentPath.fromString('/root/a/b/c').depth()).toBe(3);
    });
  });

  // ============ equals() ============
  describe('equals()', () => {
    it('returns true for identical paths', () => {
      const a = AgentPath.fromString('/root/worker');
      const b = AgentPath.fromString('/root/worker');
      expect(a.equals(b)).toBe(true);
    });

    it('returns false for different paths', () => {
      const a = AgentPath.fromString('/root/worker');
      const b = AgentPath.fromString('/root/explorer');
      expect(a.equals(b)).toBe(false);
    });

    it('root equals root', () => {
      expect(AgentPath.root().equals(AgentPath.root())).toBe(true);
    });

    it('returns false for root vs non-root', () => {
      expect(AgentPath.root().equals(AgentPath.fromString('/root/a'))).toBe(false);
    });
  });

  // ============ segments() ============
  describe('segments()', () => {
    it('returns empty array for root', () => {
      expect(AgentPath.root().segments()).toEqual([]);
    });

    it('returns ["a"] for "/root/a"', () => {
      expect(AgentPath.fromString('/root/a').segments()).toEqual(['a']);
    });

    it('returns ["a", "b", "c"] for "/root/a/b/c"', () => {
      expect(AgentPath.fromString('/root/a/b/c').segments()).toEqual(['a', 'b', 'c']);
    });
  });

  // ============ isRoot() ============
  describe('isRoot()', () => {
    it('returns true for root', () => {
      expect(AgentPath.root().isRoot()).toBe(true);
      expect(AgentPath.fromString('/root').isRoot()).toBe(true);
    });

    it('returns false for non-root', () => {
      expect(AgentPath.fromString('/root/a').isRoot()).toBe(false);
    });
  });

  // ============ Edge Cases ============
  describe('edge cases', () => {
    it('constructor is private - cannot instantiate with new', () => {
      // TypeScript prevents this at compile time, but verify the pattern
      // AgentPath should only be creatable through factory methods
      const p = AgentPath.root();
      expect(p).toBeInstanceOf(AgentPath);
    });

    it('segment at exactly max length (64) is valid', () => {
      const segment = 'a'.repeat(64);
      expect(AgentPath.isValidSegment(segment)).toBe(true);
      const p = AgentPath.fromSegments(segment);
      expect(p.name()).toBe(segment);
    });

    it('segment exceeding max length (65) is invalid', () => {
      const segment = 'a'.repeat(65);
      expect(AgentPath.isValidSegment(segment)).toBe(false);
      expect(() => AgentPath.fromSegments(segment)).toThrow(ValidationError);
    });

    it('single character segment is valid', () => {
      expect(AgentPath.isValidSegment('a')).toBe(true);
      const p = AgentPath.fromSegments('a');
      expect(p.toString()).toBe('/root/a');
    });

    it('path with underscores and digits is valid', () => {
      const p = AgentPath.fromString('/root/my_agent_v2');
      expect(p.toString()).toBe('/root/my_agent_v2');
      expect(p.name()).toBe('my_agent_v2');
    });

    it('resolve from root with "../child" throws (root has no parent)', () => {
      expect(() => AgentPath.root().resolve('../child')).toThrow(ValidationError);
    });

    it('fromSegments with mixed valid and invalid throws on first invalid', () => {
      expect(() => AgentPath.fromSegments('valid', 'Invalid')).toThrow(ValidationError);
    });

    it('tryFromString returns null for segment too long', () => {
      const longSegment = 'a'.repeat(65);
      expect(AgentPath.tryFromString(`/root/${longSegment}`)).toBeNull();
    });

    it('multiple resolve hops work correctly', () => {
      // /root/a/b/c resolve "../../x" -> /root/a/x
      const p = AgentPath.fromString('/root/a/b/c');
      const resolved = p.resolve('../../x');
      expect(resolved.toString()).toBe('/root/a/x');
    });

    it('resolve "././child" collapses correctly', () => {
      const p = AgentPath.fromString('/root/a');
      const resolved = p.resolve('././child');
      expect(resolved.toString()).toBe('/root/a/child');
    });

    it('resolve with empty parts (consecutive slashes) skips them', () => {
      // Note: this tests the internal handling, the reference
      // "a//b" would split into ["a", "", "b"] and skip the empty part
      const p = AgentPath.fromString('/root/a');
      const resolved = p.resolve('a//b');
      expect(resolved.toString()).toBe('/root/a/a/b');
    });

    it('resolve absolute "/root" returns root', () => {
      const p = AgentPath.fromString('/root/a/b');
      const resolved = p.resolve('/root');
      expect(resolved.toString()).toBe('/root');
      expect(resolved.isRoot()).toBe(true);
    });

    it('root join then parent returns root', () => {
      const p = AgentPath.root().join('a').parent();
      expect(p).not.toBeNull();
      expect(p!.toString()).toBe('/root');
    });
  });

  // ============ ValidationError ============
  describe('ValidationError', () => {
    it('has correct name', () => {
      try {
        AgentPath.fromString('/invalid');
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        expect((e as ValidationError).name).toBe('ValidationError');
        expect((e as ValidationError).message).toContain('Invalid agent path');
      }
    });

    it('is an Error instance', () => {
      try {
        AgentPath.fromString('/invalid');
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    });
  });
});
