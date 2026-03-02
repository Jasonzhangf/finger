import { describe, it, expect, beforeAll } from 'vitest';
import { AgentRuntimeBlock } from '../../src/blocks/agent-runtime-block/index.js';
import { MessageHub } from '../../src/orchestration/message-hub.js';
import { ModuleRegistry } from '../../src/orchestration/module-registry.js';
import { UnifiedEventBus } from '../../src/runtime/event-bus.js';
import { ToolRegistry } from '../../src/runtime/tool-registry.js';
import { RuntimeFacade } from '../../src/runtime/runtime-facade.js';

function createDeps() {
  const hub = new MessageHub();
  const moduleRegistry = new ModuleRegistry(hub);
  const eventBus = new UnifiedEventBus();
  const toolRegistry = new ToolRegistry();

  const baseSession = {
    id: 'session-1',
    name: 'Test Session',
    projectPath: '/tmp',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const sessionManager = {
    createSession: () => baseSession,
    getSession: () => baseSession,
    getCurrentSession: () => baseSession,
    setCurrentSession: () => true,
    listSessions: () => [baseSession],
    addMessage: () => ({ id: 'msg-1', timestamp: new Date().toISOString() }),
    getMessages: () => [],
    deleteSession: () => true,
    pauseSession: () => true,
    resumeSession: () => true,
  };

  const runtime = new RuntimeFacade(eventBus, sessionManager, toolRegistry);

  const deps = {
    moduleRegistry,
    hub,
    runtime,
    toolRegistry,
    eventBus,
    workflowManager: {
      listWorkflows: () => [],
      pauseWorkflow: () => false,
      resumeWorkflow: () => false,
    },
    sessionManager: {
      pauseSession: () => true,
      resumeSession: () => true,
      getCurrentSession: () => ({ id: baseSession.id }),
    },
    chatCodexRunner: {
      listSessionStates: () => [],
      interruptSession: () => [],
    },
    getLoadedAgentConfigs: () => [],
  };

  return { deps, moduleRegistry };
}

describe('AgentRuntimeBlock', () => {
  let deps: ReturnType<typeof createDeps>['deps'];

  beforeAll(async () => {
    const created = createDeps();
    deps = created.deps;

    await created.moduleRegistry.register({
      id: 'finger-executor',
      type: 'output',
      name: 'Finger Executor',
      version: '1.0.0',
      handle: async (message: unknown) => ({ ok: true, message }),
      metadata: { role: 'executor' },
    });
  });

  it('lists startup templates', async () => {
    const block = new AgentRuntimeBlock('agent-runtime', deps);
    const templates = await block.execute('list_startup_templates', {});
    expect((templates as Array<{ id: string }>).some(t => t.id === 'finger-orchestrator')).toBe(true);
  });

  it('fails deploy without target', async () => {
    const block = new AgentRuntimeBlock('agent-runtime', deps);
    const result = await block.execute('deploy', {});
    expect(result).toMatchObject({ success: false, error: 'target agent is required' });
  });

  it('deploys and dispatches to a runtime module', async () => {
    const block = new AgentRuntimeBlock('agent-runtime', deps);
    const deployed = await block.execute('deploy', { targetAgentId: 'finger-executor', instanceCount: 1 });
    expect(deployed).toMatchObject({ success: true });

    const dispatch = await block.execute('dispatch', {
      sourceAgentId: 'finger-orchestrator',
      targetAgentId: 'finger-executor',
      task: { text: 'hello' },
      blocking: true,
    });

    expect(dispatch).toMatchObject({ ok: true, status: 'completed' });
  });

  it('returns control status', async () => {
    const block = new AgentRuntimeBlock('agent-runtime', deps);
    const result = await block.execute('control', { action: 'status' });
    expect(result).toMatchObject({ ok: true, action: 'status', status: 'completed' });
  });
});
