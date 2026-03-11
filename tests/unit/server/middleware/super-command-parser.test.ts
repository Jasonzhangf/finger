import { describe, it, expect } from 'vitest';
import { parseSuperCommand } from '../../../../src/server/middleware/super-command-parser.js';

describe('SuperCommandParser', () => {
  describe('Super command block detection', () => {
    it('should detect <##@system##> tag', () => {
      const result = parseSuperCommand('<####><##@system##>list projects<####>');
      expect(result.type).toBe('super_command');
      expect(result.blocks).toBeDefined();
      expect(result.blocks![0].type).toBe('system');
      expect(result.effectiveContent).toBe('list projects');
      expect(result.targetAgent).toBe('finger-system-agent');
      expect(result.shouldSwitch).toBe(true);
    });

    it('should detect <##@system:<pwd=xxx>##> with password', () => {
      const result = parseSuperCommand('<####><##@system:<pwd=secret123>##>restart daemon<####>');
      expect(result.type).toBe('super_command');
      expect(result.blocks![0].password).toBe('secret123');
      expect(result.effectiveContent).toBe('restart daemon');
    });

    it('should detect <##@agent##> tag', () => {
      const result = parseSuperCommand('<####><##@agent##>continue task<####>');
      expect(result.type).toBe('super_command');
      expect(result.blocks![0].type).toBe('agent');
      expect(result.targetAgent).toBe('finger-orchestrator');
    });

    it('should handle empty super command block', () => {
      const result = parseSuperCommand('<####><##@system##><####>');
      expect(result.type).toBe('super_command');
      expect(result.effectiveContent).toBe('');
    });
  });

  describe('Content outside blocks', () => {
    it('should ignore content outside super command blocks', () => {
      const result = parseSuperCommand('ignore this<####><##@system##>real content<####>');
      expect(result.type).toBe('super_command');
      expect(result.effectiveContent).toBe('real content');
    });

    it('should ignore content after block', () => {
      const result = parseSuperCommand('<####><##@system##>command<####>ignore this too');
      expect(result.type).toBe('super_command');
      expect(result.effectiveContent).toBe('command');
    });

    it('should merge multiple block contents', () => {
      const result = parseSuperCommand('<####><##@system##>cmd1<####>ignore<####><##@agent##>cmd2<####>');
      expect(result.type).toBe('super_command');
      expect(result.effectiveContent).toBe('cmd1\ncmd2');
    });
  });

  describe('Normal messages', () => {
    it('should return normal for messages without super blocks', () => {
      const result = parseSuperCommand('normal message');
      expect(result.type).toBe('normal');
      expect(result.effectiveContent).toBe('normal message');
      expect(result.targetAgent).toBe('');
      expect(result.shouldSwitch).toBe(false);
    });

    it('should return normal for partial tags', () => {
      const result = parseSuperCommand('<##@system##> not in block');
      expect(result.type).toBe('normal');
    });

    it('should return normal for unclosed blocks', () => {
      const result = parseSuperCommand('<####><##@system##>unclosed');
      expect(result.type).toBe('normal');
    });
  });

  describe('Invalid blocks', () => {
    it('should mark block without tags as invalid', () => {
      const result = parseSuperCommand('<####>no tags here<####>');
      expect(result.type).toBe('super_command');
      expect(result.blocks![0].type).toBe('invalid');
      expect(result.targetAgent).toBe('');
    });
  });

  describe('Password extraction', () => {
    it('should extract simple password', () => {
      const result = parseSuperCommand('<####><##@system:<pwd=mypass>##>test<####>');
      expect(result.blocks![0].password).toBe('mypass');
    });

    it('should handle password with special chars', () => {
      const result = parseSuperCommand('<####><##@system:<pwd=p@ss!123>##>test<####>');
      expect(result.blocks![0].password).toBe('p@ss!123');
    });
  });
});
