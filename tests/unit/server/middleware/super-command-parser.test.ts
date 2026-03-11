import { describe, it, expect } from 'vitest';
import { parseSuperCommand } from '../../../../src/server/middleware/super-command-parser.js';

describe('super-command-parser', () => {
  describe('system tag', () => {
    it('parses <##@system##> tag', () => {
      const result = parseSuperCommand('<##@system##>pwd');
      expect(result.type).toBe('super_command');
      expect(result.targetAgent).toBe('finger-system-agent');
      expect(result.shouldSwitch).toBe(true);
      expect(result.effectiveContent).toBe('pwd');
    });

    it('parses <##@system##> with password', () => {
      const result = parseSuperCommand('<##@system:<pwd=secret>##>dangerous command');
      expect(result.type).toBe('super_command');
      expect(result.targetAgent).toBe('finger-system-agent');
      expect(result.blocks?.[0].password).toBe('secret');
      expect(result.effectiveContent).toBe('dangerous command');
    });

    it('handles whitespace after tag', () => {
      const result = parseSuperCommand('<##@system##>   trimmed content   ');
      expect(result.effectiveContent).toBe('trimmed content');
    });

    it('handles empty content', () => {
      const result = parseSuperCommand('<##@system##>');
      expect(result.effectiveContent).toBe('');
    });
  });

  describe('agent tag', () => {
    it('parses <##@agent##> tag', () => {
      const result = parseSuperCommand('<##@agent##>hello');
      expect(result.type).toBe('super_command');
      expect(result.targetAgent).toBe('finger-orchestrator');
      expect(result.shouldSwitch).toBe(true);
      expect(result.effectiveContent).toBe('hello');
    });

    it('handles whitespace after tag', () => {
      const result = parseSuperCommand('<##@agent##>   back to business   ');
      expect(result.effectiveContent).toBe('back to business');
    });
  });

  describe('normal messages', () => {
    it('returns normal for messages without tags', () => {
      const result = parseSuperCommand('hello world');
      expect(result.type).toBe('normal');
      expect(result.targetAgent).toBe('');
      expect(result.shouldSwitch).toBe(false);
      expect(result.effectiveContent).toBe('hello world');
    });

    it('returns normal for tags not at start', () => {
      const result = parseSuperCommand('prefix <##@system##>pwd');
      expect(result.type).toBe('normal');
    });

    it('handles empty content', () => {
      const result = parseSuperCommand('');
      expect(result.type).toBe('normal');
    });
  });
});
