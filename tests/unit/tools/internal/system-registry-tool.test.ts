import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../core/finger-paths.js', () => ({
  FINGER_PATHS: {
    home: '/tmp',
  },
}));

describe('system-registry-tool', () => {
  const registryPath = '/tmp/system/registry.json';
  let ToolRegistry: typeof import('../../../../src/runtime/tool-registry.js').ToolRegistry;
  let registerSystemRegistryTool: typeof import('../../../../src/tools/internal/system-registry-tool.js').registerSystemRegistryTool;

  beforeEach(async () => {
    ({ ToolRegistry } = await import('../../../../src/runtime/tool-registry.js'));
    ({ registerSystemRegistryTool } = await import('../../../../src/tools/internal/system-registry-tool.js'));
  });

  afterEach(async () => {
    try {
      const { promises: fs } = await import('fs');
      await fs.unlink(registryPath);
    } catch {
      // ignore cleanup errors
    }
  });

  it('registers and lists agents', async () => {
    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    registerSystemRegistryTool(registry, () => ({}) as any);

    const registerResult = await registry.execute('system-registry-tool', {
      action: 'register',
      projectId: 'proj-1',
      projectPath: '/tmp/proj-1',
      projectName: 'Project 1',
      agentId: 'agent-1',
    });

    expect((registerResult as any).ok).toBe(true);

    const listResult = await registry.execute('system-registry-tool', {
      action: 'list',
    });

    expect((listResult as any).ok).toBe(true);
    expect((listResult as any).agents).toHaveLength(1);
  });
});
