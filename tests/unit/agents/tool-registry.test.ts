import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry, Tool } from '../../../src/agents/shared/tool-registry.js';
import { ToolAssignment } from '../../../src/agents/protocol/schema.js';

describe('ToolRegistry', () => {
  const createMockTool = (name: string): Tool => ({
    name,
    description: `${name} tool`,
    params: {},
    handler: vi.fn(async (params) => ({ ok: true, params })),
  });

  it('registers and retrieves tools', () => {
    const registry = new ToolRegistry();
    const tool = createMockTool('file.read');

    registry.register(tool);

    expect(registry.get('file.read')).toBeDefined();
    expect(registry.list()).toHaveLength(1);
  });

  it('grants tool permission to an agent', () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool('file.write'));

    const assignment: ToolAssignment = {
      toolName: 'file.write',
      action: 'grant',
      constraints: { maxFiles: 3 },
    };

    const granted = registry.grant('executor-1', assignment);

    expect(granted).toBe(true);
    expect(registry.canUse('executor-1', 'file.write')).toBe(true);
    expect(registry.getConstraints('executor-1', 'file.write')).toEqual({ maxFiles: 3 });
  });

  it('rejects granting non-existent tool', () => {
    const registry = new ToolRegistry();
    const assignment: ToolAssignment = {
      toolName: 'not.exists',
      action: 'grant',
    };

    expect(registry.grant('executor-1', assignment)).toBe(false);
    expect(registry.canUse('executor-1', 'not.exists')).toBe(false);
  });

  it('revokes tool permission', () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool('shell.exec'));

    registry.grant('executor-1', { toolName: 'shell.exec', action: 'grant' });
    expect(registry.canUse('executor-1', 'shell.exec')).toBe(true);

    const revoked = registry.revoke('executor-1', 'shell.exec');
    expect(revoked).toBe(true);
    expect(registry.canUse('executor-1', 'shell.exec')).toBe(false);
  });

  it('lists only granted tools', () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool('file.read'));
    registry.register(createMockTool('file.write'));

    registry.grant('executor-1', { toolName: 'file.read', action: 'grant' });
    registry.grant('executor-1', { toolName: 'file.write', action: 'grant' });
    registry.revoke('executor-1', 'file.write');

    const tools = registry.listGranted('executor-1');
    expect(tools).toHaveLength(1);
    expect(tools[0].toolName).toBe('file.read');
  });

  it('executes granted tool successfully', async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool('task.query'));
    registry.grant('executor-1', { toolName: 'task.query', action: 'grant' });

    const result = await registry.execute('executor-1', 'task.query', { id: 'f-1' });

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ ok: true, params: { id: 'f-1' } });
  });

  it('denies execution when tool not granted', async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool('task.query'));

    const result = await registry.execute('executor-1', 'task.query', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('not granted');
  });
});
