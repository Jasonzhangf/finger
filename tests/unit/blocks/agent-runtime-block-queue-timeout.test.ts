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
        .filter((event) => event?.type === 'agent_runtime_dispatch')
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
});
