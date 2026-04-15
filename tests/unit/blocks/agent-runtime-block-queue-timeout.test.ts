import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeBlock } from '../../../src/blocks/agent-runtime-block/index.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('AgentRuntimeBlock queue timeout fallback', () => {
  it('falls back to mailbox instead of failing when queue wait times out', async () => {
    vi.useFakeTimers();
    try {
      const first = createDeferred<{ ok: boolean }>();
      const hubSendToModule = vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce({ ok: true });
      const emittedEvents = vi.fn().mockResolvedValue(undefined);
      const onDispatchQueueTimeout = vi.fn().mockReturnValue({
        delivery: 'mailbox',
        mailboxMessageId: 'msg-mailbox-1',
        summary: 'busy timeout -> mailbox',
        nextAction: 'wait ack',
      });

      const block = new AgentRuntimeBlock('agent-runtime-test', {
        moduleRegistry: {
          getAllModules: () => [{
            id: 'executor-a-loop',
            name: 'executor-a-loop',
            type: 'agent',
            metadata: { role: 'executor' },
          }] as never,
          getModule: (id: string) => (id === 'executor-a-loop'
            ? {
                id: 'executor-a-loop',
                name: 'executor-a-loop',
                type: 'agent',
                metadata: { role: 'executor' },
              } as never
            : null),
        } as never,
        hub: {
          sendToModule: hubSendToModule,
        } as never,
        runtime: {
          getAgentToolPolicy: () => ({
            whitelist: ['agent.dispatch'],
            blacklist: [],
          }),
          getAgentRuntimeConfig: () => null,
          setAgentRuntimeConfig: vi.fn(),
        } as never,
        toolRegistry: {
          list: () => [{ name: 'agent.dispatch', policy: 'allow' }],
        } as never,
        eventBus: {
          emit: emittedEvents,
        } as never,
        workflowManager: {
          listWorkflows: () => [],
          pauseWorkflow: () => true,
          resumeWorkflow: () => true,
        },
        sessionManager: {
          pauseSession: () => true,
          resumeSession: () => true,
          getCurrentSession: () => ({ id: 'session-default' }),
        },
        chatCodexRunner: {
          listSessionStates: () => [],
          interruptSession: () => [],
        },
        resourcePool: {
          getAllResources: () => [],
          addResource: vi.fn(),
        } as never,
        getLoadedAgentConfigs: () => [{
          filePath: '/tmp/executor-a.agent.json',
          config: {
            id: 'executor-a',
            name: 'Executor A',
            role: 'executor',
            implementations: [
              { id: 'native-main', kind: 'native', moduleId: 'executor-a-loop', enabled: true },
            ],
            tools: {
              whitelist: ['agent.dispatch'],
            },
          },
        }],
        primaryOrchestratorAgentId: 'chat-codex',
        onDispatchQueueTimeout,
      });

      await block.initialize();
      await block.start();
      await block.execute('deploy', {
        targetAgentId: 'executor-a',
        targetImplementationId: 'native-main',
        sessionId: 'session-1',
        instanceCount: 1,
        launchMode: 'orchestrator',
      });

      await block.execute('dispatch', {
        sourceAgentId: 'chat-codex',
        targetAgentId: 'executor-a',
        task: { text: 't1' },
        blocking: false,
      });

      const timedOutDispatchPromise = block.execute('dispatch', {
        sourceAgentId: 'chat-codex',
        targetAgentId: 'executor-a',
        task: { text: 't2' },
        blocking: true,
        queueOnBusy: true,
        maxQueueWaitMs: 1_000,
      }) as Promise<{
        ok: boolean;
        status: string;
        result?: { summary?: string; messageId?: string; status?: string };
      }>;

      await vi.advanceTimersByTimeAsync(1_000);
      const timedOutDispatch = await timedOutDispatchPromise;

      expect(onDispatchQueueTimeout).toHaveBeenCalledWith(expect.objectContaining({
        sourceAgentId: 'chat-codex',
        targetAgentId: 'executor-a',
      }));
      expect(timedOutDispatch.ok).toBe(true);
      expect(timedOutDispatch.status).toBe('queued');
      expect(timedOutDispatch.result).toEqual(expect.objectContaining({
        summary: 'busy timeout -> mailbox',
        messageId: 'msg-mailbox-1',
        status: 'queued_mailbox',
      }));

      const mailboxEvent = emittedEvents.mock.calls
        .map(([event]) => event)
        .filter((event) => event?.type === 'agent_dispatch_queued')
        .at(-1);
      expect(mailboxEvent).toEqual(expect.objectContaining({
        payload: expect.objectContaining({
          status: 'queued',
          result: expect.objectContaining({
            messageId: 'msg-mailbox-1',
            status: 'queued_mailbox',
          }),
        }),
      }));

      first.resolve({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatches to system agent directly when the system agent is available', async () => {
    const hubSendToModule = vi.fn().mockResolvedValue({ ok: true, output: 'ok' });
    const onDispatchQueueTimeout = vi.fn().mockReturnValue({
      delivery: 'mailbox',
      mailboxMessageId: 'msg-system-mailbox-direct',
      summary: 'should not be used',
    });

    const block = new AgentRuntimeBlock('agent-runtime-test-system-direct', {
      moduleRegistry: {
        getAllModules: () => [{
          id: 'finger-system-agent',
          name: 'finger-system-agent',
          type: 'agent',
          metadata: { role: 'system' },
        }] as never,
        getModule: (id: string) => (id === 'finger-system-agent'
          ? {
              id: 'finger-system-agent',
              name: 'finger-system-agent',
              type: 'agent',
              metadata: { role: 'system' },
            } as never
          : null),
      } as never,
      hub: {
        sendToModule: hubSendToModule,
      } as never,
      runtime: {
        getAgentToolPolicy: () => ({
          whitelist: ['agent.dispatch'],
          blacklist: [],
        }),
        getAgentRuntimeConfig: () => null,
        setAgentRuntimeConfig: vi.fn(),
      } as never,
      toolRegistry: {
        list: () => [{ name: 'agent.dispatch', policy: 'allow' }],
      } as never,
      eventBus: {
        emit: vi.fn().mockResolvedValue(undefined),
      } as never,
      workflowManager: {
        listWorkflows: () => [],
        pauseWorkflow: () => true,
        resumeWorkflow: () => true,
      },
      sessionManager: {
        pauseSession: () => true,
        resumeSession: () => true,
        getCurrentSession: () => ({ id: 'session-system' }),
      },
      chatCodexRunner: {
        listSessionStates: () => [],
        interruptSession: () => [],
      },
      resourcePool: {
        getAllResources: () => [],
        addResource: vi.fn(),
      } as never,
      getLoadedAgentConfigs: () => [{
        filePath: '/tmp/finger-system-agent.agent.json',
        config: {
          id: 'finger-system-agent',
          name: 'System Agent',
          role: 'system',
          implementations: [
            { id: 'native-main', kind: 'native', moduleId: 'finger-system-agent', enabled: true },
          ],
          tools: {
            whitelist: ['agent.dispatch'],
          },
        },
      }],
      primaryOrchestratorAgentId: 'chat-codex',
      onDispatchQueueTimeout,
    });

    await block.initialize();
    await block.start();
    await block.execute('deploy', {
      targetAgentId: 'finger-system-agent',
      targetImplementationId: 'native-main',
      sessionId: 'session-system',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    const result = await block.execute('dispatch', {
      sourceAgentId: 'system-heartbeat',
      targetAgentId: 'finger-system-agent',
      task: { text: 'mailbox-check-direct' },
      blocking: true,
      metadata: {
        source: 'system-heartbeat',
      },
    }) as {
      ok: boolean;
      status: string;
      result?: unknown;
    };

    expect(result.ok).toBe(true);
    expect(result.status).toBe('completed');
    expect(hubSendToModule).toHaveBeenCalledTimes(1);
    expect(onDispatchQueueTimeout).not.toHaveBeenCalled();
  });

  it('routes dispatch to system agent into urgent mailbox when the system agent is busy', async () => {
    vi.useFakeTimers();
    try {
      const first = createDeferred<{ ok: boolean }>();
      const hubSendToModule = vi.fn()
        .mockImplementationOnce(() => first.promise);
      const onDispatchQueueTimeout = vi.fn().mockReturnValue({
        delivery: 'mailbox',
        mailboxMessageId: 'msg-system-mailbox-1',
        summary: 'system mailbox route',
      });

      const block = new AgentRuntimeBlock('agent-runtime-test-system', {
        moduleRegistry: {
          getAllModules: () => [{
            id: 'finger-system-agent',
            name: 'finger-system-agent',
            type: 'agent',
            metadata: { role: 'system' },
          }] as never,
          getModule: (id: string) => (id === 'finger-system-agent'
            ? {
                id: 'finger-system-agent',
                name: 'finger-system-agent',
                type: 'agent',
                metadata: { role: 'system' },
              } as never
            : null),
        } as never,
        hub: {
          sendToModule: hubSendToModule,
        } as never,
        runtime: {
          getAgentToolPolicy: () => ({
            whitelist: ['agent.dispatch'],
            blacklist: [],
          }),
          getAgentRuntimeConfig: () => null,
          setAgentRuntimeConfig: vi.fn(),
        } as never,
        toolRegistry: {
          list: () => [{ name: 'agent.dispatch', policy: 'allow' }],
        } as never,
        eventBus: {
          emit: vi.fn().mockResolvedValue(undefined),
        } as never,
        workflowManager: {
          listWorkflows: () => [],
          pauseWorkflow: () => true,
          resumeWorkflow: () => true,
        },
        sessionManager: {
          pauseSession: () => true,
          resumeSession: () => true,
          getCurrentSession: () => ({ id: 'session-system' }),
        },
        chatCodexRunner: {
          listSessionStates: () => [],
          interruptSession: () => [],
        },
        resourcePool: {
          getAllResources: () => [],
          addResource: vi.fn(),
        } as never,
        getLoadedAgentConfigs: () => [{
          filePath: '/tmp/finger-system-agent.agent.json',
          config: {
            id: 'finger-system-agent',
            name: 'System Agent',
            role: 'system',
            implementations: [
              { id: 'native-main', kind: 'native', moduleId: 'finger-system-agent', enabled: true },
            ],
            tools: {
              whitelist: ['agent.dispatch'],
            },
          },
        }],
        primaryOrchestratorAgentId: 'chat-codex',
        onDispatchQueueTimeout,
      });

      await block.initialize();
      await block.start();
      await block.execute('deploy', {
        targetAgentId: 'finger-system-agent',
        targetImplementationId: 'native-main',
        sessionId: 'session-system',
        instanceCount: 1,
        launchMode: 'orchestrator',
      });

      await block.execute('dispatch', {
        sourceAgentId: 'system-heartbeat',
        targetAgentId: 'finger-system-agent',
        task: { text: 'occupy-system-agent' },
        blocking: false,
      });

      const resultPromise = block.execute('dispatch', {
        sourceAgentId: 'system-heartbeat',
        targetAgentId: 'finger-system-agent',
        task: { text: 'mailbox-check' },
        blocking: true,
        queueOnBusy: true,
        maxQueueWaitMs: 1_000,
        metadata: { source: 'system-heartbeat' },
      }) as Promise<{
        ok: boolean;
        status: string;
        result?: { status?: string; messageId?: string };
      }>;

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(onDispatchQueueTimeout).toHaveBeenCalledWith(expect.objectContaining({
        sourceAgentId: 'system-heartbeat',
        targetAgentId: 'finger-system-agent',
      }));
      expect(result.ok).toBe(true);
      expect(result.status).toBe('queued');
      expect(result.result).toEqual(expect.objectContaining({
        status: 'queued_mailbox',
        messageId: 'msg-system-mailbox-1',
      }));
      expect(hubSendToModule).toHaveBeenCalledTimes(1);

      first.resolve({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects self-dispatch instead of routing/queuing', async () => {
    const hubSendToModule = vi.fn().mockResolvedValue({ ok: true, output: 'self-ok' });
    const onDispatchQueueTimeout = vi.fn().mockReturnValue({
      delivery: 'mailbox',
      mailboxMessageId: 'msg-system-self-mailbox',
      summary: 'should not be used for self-dispatch',
    });

    const block = new AgentRuntimeBlock('agent-runtime-test-system-self', {
      moduleRegistry: {
        getAllModules: () => [{
          id: 'finger-system-agent',
          name: 'finger-system-agent',
          type: 'agent',
          metadata: { role: 'system' },
        }] as never,
        getModule: (id: string) => (id === 'finger-system-agent'
          ? {
              id: 'finger-system-agent',
              name: 'finger-system-agent',
              type: 'agent',
              metadata: { role: 'system' },
            } as never
          : null),
      } as never,
      hub: {
        sendToModule: hubSendToModule,
      } as never,
      runtime: {
        getAgentToolPolicy: () => ({
          whitelist: ['agent.dispatch'],
          blacklist: [],
        }),
        getAgentRuntimeConfig: () => null,
        setAgentRuntimeConfig: vi.fn(),
      } as never,
      toolRegistry: {
        list: () => [{ name: 'agent.dispatch', policy: 'allow' }],
      } as never,
      eventBus: {
        emit: vi.fn().mockResolvedValue(undefined),
      } as never,
      workflowManager: {
        listWorkflows: () => [],
        pauseWorkflow: () => true,
        resumeWorkflow: () => true,
      },
      sessionManager: {
        pauseSession: () => true,
        resumeSession: () => true,
        getCurrentSession: () => ({ id: 'session-system' }),
      },
      chatCodexRunner: {
        listSessionStates: () => [],
        interruptSession: () => [],
      },
      resourcePool: {
        getAllResources: () => [],
        addResource: vi.fn(),
      } as never,
      getLoadedAgentConfigs: () => [{
        filePath: '/tmp/finger-system-agent.agent.json',
        config: {
          id: 'finger-system-agent',
          name: 'System Agent',
          role: 'system',
          implementations: [
            { id: 'native-main', kind: 'native', moduleId: 'finger-system-agent', enabled: true },
          ],
          tools: {
            whitelist: ['agent.dispatch'],
          },
        },
      }],
      primaryOrchestratorAgentId: 'chat-codex',
      onDispatchQueueTimeout,
    });

    await block.initialize();
    await block.start();
    await block.execute('deploy', {
      targetAgentId: 'finger-system-agent',
      targetImplementationId: 'native-main',
      sessionId: 'session-system',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    const result = await block.execute('dispatch', {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-system-agent',
      task: { text: 'self-dispatch' },
      blocking: false,
    }) as {
      ok: boolean;
      status: string;
      result?: unknown;
    };

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect((result as { error?: string }).error).toContain('self-dispatch forbidden');
    expect(hubSendToModule).not.toHaveBeenCalled();
    expect(onDispatchQueueTimeout).not.toHaveBeenCalled();
  });

  it('keeps self-dispatch fail-fast even while target would otherwise be busy', async () => {
    vi.useFakeTimers();
    try {
      const hubSendToModule = vi.fn();
      const onDispatchQueueTimeout = vi.fn().mockReturnValue({
        delivery: 'mailbox',
        mailboxMessageId: 'msg-self-timeout-should-not-happen',
        summary: 'should not happen',
      });

      const block = new AgentRuntimeBlock('agent-runtime-test-system-self-timeout', {
        moduleRegistry: {
          getAllModules: () => [{
            id: 'finger-system-agent',
            name: 'finger-system-agent',
            type: 'agent',
            metadata: { role: 'system' },
          }] as never,
          getModule: (id: string) => (id === 'finger-system-agent'
            ? {
                id: 'finger-system-agent',
                name: 'finger-system-agent',
                type: 'agent',
                metadata: { role: 'system' },
              } as never
            : null),
        } as never,
        hub: {
          sendToModule: hubSendToModule,
        } as never,
        runtime: {
          getAgentToolPolicy: () => ({
            whitelist: ['agent.dispatch'],
            blacklist: [],
          }),
          getAgentRuntimeConfig: () => null,
          setAgentRuntimeConfig: vi.fn(),
        } as never,
        toolRegistry: {
          list: () => [{ name: 'agent.dispatch', policy: 'allow' }],
        } as never,
        eventBus: {
          emit: vi.fn().mockResolvedValue(undefined),
        } as never,
        workflowManager: {
          listWorkflows: () => [],
          pauseWorkflow: () => true,
          resumeWorkflow: () => true,
        },
        sessionManager: {
          pauseSession: () => true,
          resumeSession: () => true,
          getCurrentSession: () => ({ id: 'session-system' }),
        },
        chatCodexRunner: {
          listSessionStates: () => [],
          interruptSession: () => [],
        },
        resourcePool: {
          getAllResources: () => [],
          addResource: vi.fn(),
        } as never,
        getLoadedAgentConfigs: () => [{
          filePath: '/tmp/finger-system-agent.agent.json',
          config: {
            id: 'finger-system-agent',
            name: 'System Agent',
            role: 'system',
            implementations: [
              { id: 'native-main', kind: 'native', moduleId: 'finger-system-agent', enabled: true },
            ],
            tools: {
              whitelist: ['agent.dispatch'],
            },
          },
        }],
        primaryOrchestratorAgentId: 'chat-codex',
        onDispatchQueueTimeout,
      });

      await block.initialize();
      await block.start();
      await block.execute('deploy', {
        targetAgentId: 'finger-system-agent',
        targetImplementationId: 'native-main',
        sessionId: 'session-system',
        instanceCount: 1,
        launchMode: 'orchestrator',
      });

      const firstResult = await block.execute('dispatch', {
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-system-agent',
        task: { text: 'self-dispatch-1' },
        blocking: false,
      }) as { ok: boolean; status: string; error?: string };
      expect(firstResult.ok).toBe(false);
      expect(firstResult.status).toBe('failed');
      expect(firstResult.error).toContain('self-dispatch forbidden');

      const queuedResult = await block.execute('dispatch', {
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-system-agent',
        task: { text: 'self-dispatch-2' },
        blocking: false,
        queueOnBusy: true,
        maxQueueWaitMs: 1_000,
      }) as { ok: boolean; status: string };
      expect(queuedResult.ok).toBe(false);
      expect(queuedResult.status).toBe('failed');
      expect((queuedResult as { error?: string }).error).toContain('self-dispatch forbidden');

      await vi.advanceTimersByTimeAsync(5_000);
      expect(onDispatchQueueTimeout).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(hubSendToModule).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
