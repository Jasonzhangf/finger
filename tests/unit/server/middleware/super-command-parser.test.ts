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
      expect(result.blocks?.[0].type).toBe('system');
    });

    it('parses <##@system##> with password', () => {
      const result = parseSuperCommand('<##@system:pwd=secret##>dangerous command');
      expect(result.type).toBe('super_command');
      expect(result.targetAgent).toBe('finger-system-agent');
      expect(result.blocks?.[0].password).toBe('secret');
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
  });

  describe('project commands', () => {
    it('parses <##@project:list##>', () => {
      const result = parseSuperCommand('<##@project:list##>');
      expect(result.type).toBe('super_command');
      expect(result.blocks?.[0].type).toBe('project_list');
    });

    it('parses <##@project:switch@/path/to/project##>', () => {
      const result = parseSuperCommand('<##@project:switch@/Users/test/myproject##>');
      expect(result.type).toBe('super_command');
      expect(result.blocks?.[0].type).toBe('project_switch');
      expect(result.blocks?.[0].path).toBe('/Users/test/myproject');
    });
  });

  describe('session commands', () => {
    it('parses <##@session:list##>', () => {
      const result = parseSuperCommand('<##@session:list##>');
      expect(result.type).toBe('super_command');
      expect(result.blocks?.[0].type).toBe('session_list');
    });

    it('parses <##@session:switch@session-123##>', () => {
      const result = parseSuperCommand('<##@session:switch@session-123##>');
      expect(result.type).toBe('super_command');
      expect(result.blocks?.[0].type).toBe('session_switch');
      expect(result.blocks?.[0].sessionId).toBe('session-123');
    });
  });

  describe('normal messages', () => {
    it('returns normal for messages without tags', () => {
      const result = parseSuperCommand('hello world');
      expect(result.type).toBe('normal');
    });

    it('returns normal for tags not at start', () => {
      const result = parseSuperCommand('prefix <##@system##>pwd');
      expect(result.type).toBe('normal');
    });
  });
});
