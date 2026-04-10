import { describe, it, expect } from 'vitest';
import { AgentPathUtils, OperationUtils } from '../../../src/protocol/operation-types.js';

describe('Protocol: Operation Types', () => {
  describe('AgentPathUtils', () => {
    it('should create root path', () => {
      expect(AgentPathUtils.root()).toBe('/root');
    });

    it('should create system coordinator path', () => {
      expect(AgentPathUtils.systemCoordinator()).toBe('/root/finger-system-agent');
    });

    it('should create project executor path', () => {
      expect(AgentPathUtils.projectExecutor()).toBe('/root/finger-project-agent');
    });

    it('should validate valid paths', () => {
      expect(AgentPathUtils.isValid('/root')).toBe(true);
      expect(AgentPathUtils.isValid('/root/finger-system-agent')).toBe(true);
      expect(AgentPathUtils.isValid('/root/finger-project-agent')).toBe(true);
      expect(AgentPathUtils.isValid('/root/finger-project-agent/sub_agent')).toBe(true);
    });

    it('should reject invalid paths', () => {
      expect(AgentPathUtils.isValid('/invalid')).toBe(false);
      expect(AgentPathUtils.isValid('/root/UPPERCASE')).toBe(false);
      expect(AgentPathUtils.isValid('/root/with spaces')).toBe(false);
      expect(AgentPathUtils.isValid('')).toBe(false);
    });

    it('should get name from path', () => {
      expect(AgentPathUtils.name('/root')).toBe('root');
      expect(AgentPathUtils.name('/root/finger-system-agent')).toBe('finger-system-agent');
    });

    it('should get parent path', () => {
      expect(AgentPathUtils.parent('/root')).toBe(null);
      expect(AgentPathUtils.parent('/root/finger-system-agent')).toBe('/root');
    });

    it('should join paths', () => {
      const child = AgentPathUtils.join('/root', 'child_agent');
      expect(child).toBe('/root/child_agent');
    });

    it('should reject invalid child names', () => {
      expect(() => {
        AgentPathUtils.join('/root', 'UPPERCASE');
      }).toThrow();
    });

    it('should identify system coordinator', () => {
      expect(AgentPathUtils.isSystemCoordinator('/root')).toBe(true);
      expect(AgentPathUtils.isSystemCoordinator('/root/finger-system-agent')).toBe(true);
      expect(AgentPathUtils.isSystemCoordinator('/root/finger-project-agent')).toBe(false);
    });

    it('should identify project executor', () => {
      expect(AgentPathUtils.isProjectExecutor('/root/finger-project-agent')).toBe(true);
      expect(AgentPathUtils.isProjectExecutor('/root')).toBe(false);
    });
  });

  describe('OperationUtils', () => {
    it('should generate unique opIds', () => {
      const id1 = OperationUtils.generateOpId();
      const id2 = OperationUtils.generateOpId();
      expect(id1).not.toBe(id2);
      expect(id1.startsWith('op-')).toBe(true);
    });

    it('should create operation with required fields', () => {
      const op = OperationUtils.create(
        '/root/finger-system-agent' as any,
        '/root/finger-project-agent' as any,
        'dispatch_task',
        { taskId: 'task-1' } as any,
      );
      expect(op.opId).toBeDefined();
      expect(op.from).toBe('/root/finger-system-agent');
      expect(op.to).toBe('/root/finger-project-agent');
      expect(op.intent).toBe('dispatch_task');
      expect(op.timestamp).toBeDefined();
    });

    it('should validate operation', () => {
      const validOp = OperationUtils.create(
        '/root/finger-system-agent' as any,
        '/root/finger-project-agent' as any,
        'dispatch_task',
        { taskId: 'task-1' } as any,
      );
      const result = OperationUtils.validate(validOp);
      expect(result.valid).toBe(true);
      expect(result.missing.length).toBe(0);
    });

    it('should detect missing fields', () => {
      const result = OperationUtils.validate({} as any);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('opId');
      expect(result.missing).toContain('from');
      expect(result.missing).toContain('to');
    });

    it('should validate AgentPath format', () => {
      const valid = OperationUtils.validateAgentPath('/root/finger-system-agent');
      expect(valid.valid).toBe(true);

      const invalid = OperationUtils.validateAgentPath('/invalid');
      expect(invalid.valid).toBe(false);
      expect(invalid.error).toBeDefined();
    });
  });
});
