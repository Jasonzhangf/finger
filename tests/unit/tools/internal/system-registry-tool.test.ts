import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('system-registry-tool', () => {
  let tempHome = '';
  let ToolRegistry: typeof import('../../../../src/runtime/tool-registry.js').ToolRegistry;
  let registerSystemRegistryTool: typeof import('../../../../src/tools/internal/system-registry-tool.js').registerSystemRegistryTool;

  beforeEach(async () => {
    vi.resetModules();
    const { promises: fs } = await import('fs');
    const { tmpdir } = await import('os');
    const path = await import('path');
    tempHome = await fs.mkdtemp(path.join(tmpdir(), 'finger-system-registry-test-'));
    vi.doMock('../../../../src/core/finger-paths.js', async () => {
      const actual = await vi.importActual<typeof import('../../../../src/core/finger-paths.js')>(
        '../../../../src/core/finger-paths.js',
      );
      return {
        ...actual,
        FINGER_HOME: tempHome,
        FINGER_PATHS: actual.getFingerPaths(tempHome),
        resolveFingerHome: () => tempHome,
      };
    });
    ({ ToolRegistry } = await import('../../../../src/runtime/tool-registry.js'));
    ({ registerSystemRegistryTool } = await import('../../../../src/tools/internal/system-registry-tool.js'));
  });

  afterEach(async () => {
    try {
      const { promises: fs } = await import('fs');
      await fs.rm(tempHome, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    vi.doUnmock('../../../../src/core/finger-paths.js');
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
    expect((listResult as any).agents.length).toBeGreaterThanOrEqual(1);
    // The newly registered agent should be in the list
    const found = (listResult as any).agents.find((a: any) => a.projectId === 'proj-1' || a.agentId === 'agent-1');
    expect(found).toBeDefined();
  });
});
