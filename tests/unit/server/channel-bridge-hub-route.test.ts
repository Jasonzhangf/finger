import { describe, it, expect, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { createChannelBridgeHubRoute } from '../../../src/server/modules/channel-bridge-hub-route.js';
import { AskManager } from '../../../src/orchestration/ask/ask-manager.js';
import { ChannelContextManager } from '../../../src/orchestration/channel-context-manager.js';
import { UnifiedEventBus } from '../../../src/runtime/event-bus.js';

describe('channel-bridge-hub-route user.ask async adaptation', () => {
  it('resolves pending ask for qqbot without dispatching a new task', async () => {
    ChannelContextManager.getInstance().clearContext('qqbot');
    ChannelContextManager.getInstance().updateContext('qqbot', 'system', 'finger-system-agent');
    const askManager = new AskManager(5_000);
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'reply-1' });
    const addMessage = vi.fn().mockResolvedValue(undefined);
    const ensureSession = vi.fn();
    const updateContext = vi.fn();
    const getSession = vi.fn().mockReturnValue({
      id: 'user-user-1',
      context: {},
    });
    const getOrCreateSystemSession = vi.fn().mockReturnValue({ id: 'system-session-1' });
    const dispatchTaskToAgent = vi.fn();

    const route = createChannelBridgeHubRoute({
      channelBridgeManager: {
        sendMessage,
      } as any,
      sessionManager: {
        ensureSession,
        updateContext,
        getSession,
        getOrCreateSystemSession,
        addMessage,
        getMessages: vi.fn().mockReturnValue([]),
      } as any,
      askManager,
      dispatchTaskToAgent,
      eventBus: new UnifiedEventBus(),
      runtime: {},
    });

    const opened = askManager.open({
      question: '请选择一个选项',
      options: ['确认', '取消'],
      agentId: 'finger-project-agent',
      sessionId: 'user-user-1',
      channelId: 'qqbot',
      userId: 'user-1',
    });

    await route({
      payload: {
        id: 'msg-1',
        channelId: 'qqbot',
        accountId: 'acc-1',
        type: 'direct',
        senderId: 'user-1',
        senderName: 'User 1',
        content: '1',
        timestamp: Date.now(),
        metadata: {},
      },
    });

    const resolution = await opened.result;
    expect(resolution.ok).toBe(true);
    expect(resolution.selectedOption).toBe('确认');
    expect(dispatchTaskToAgent).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('qqbot', expect.objectContaining({
      to: 'user-1',
      text: expect.stringContaining('已收到你的回复'),
    }));
  });

  it('sends failure reply when system direct path is unavailable (must not fallback to dispatch)', async () => {
    ChannelContextManager.getInstance().clearContext('qqbot');
    ChannelContextManager.getInstance().updateContext('qqbot', 'system', 'finger-system-agent');
    const askManager = new AskManager(5_000);
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'reply-2' });
    const addMessage = vi.fn().mockResolvedValue(undefined);
    const ensureSession = vi.fn();
    const updateContext = vi.fn();
    const getSession = vi.fn().mockReturnValue({
      id: 'user-user-1',
      context: {},
    });
    const getOrCreateSystemSession = vi.fn().mockReturnValue({ id: 'system-session-1' });
    const dispatchTaskToAgent = vi.fn();

    const route = createChannelBridgeHubRoute({
      channelBridgeManager: {
        sendMessage,
      } as any,
      sessionManager: {
        ensureSession,
        updateContext,
        getSession,
        getOrCreateSystemSession,
        addMessage,
        getMessages: vi.fn().mockReturnValue([]),
      } as any,
      askManager,
      dispatchTaskToAgent,
      eventBus: new UnifiedEventBus(),
      runtime: {},
    });

    await route({
      payload: {
        id: 'msg-2',
        channelId: 'qqbot',
        accountId: 'acc-1',
        type: 'direct',
        senderId: 'user-1',
        senderName: 'User 1',
        content: 'hello',
        timestamp: Date.now(),
        metadata: {},
      },
    });

    expect(dispatchTaskToAgent).toHaveBeenCalledTimes(1);
    expect(dispatchTaskToAgent).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: 'finger-system-agent',
      sessionId: 'system-session-1',
    }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('routes direct user input to system module without dispatch queue when directSendToModule is available', async () => {
    ChannelContextManager.getInstance().clearContext('qqbot');
    ChannelContextManager.getInstance().updateContext('qqbot', 'system', 'finger-system-agent');
    const askManager = new AskManager(5_000);
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'reply-3' });
    const addMessage = vi.fn().mockResolvedValue(undefined);
    const ensureSession = vi.fn();
    const updateContext = vi.fn();
    const getSession = vi.fn().mockReturnValue({
      id: 'system-session-2',
      context: {},
    });
    const getOrCreateSystemSession = vi.fn().mockReturnValue({ id: 'system-session-2' });
    const dispatchTaskToAgent = vi.fn();
    const directSendToModule = vi.fn().mockResolvedValue({
      success: true,
      response: 'direct ok',
    });
    const runtimeSetCurrentSession = vi.fn().mockReturnValue(true);

    const route = createChannelBridgeHubRoute({
      channelBridgeManager: {
        sendMessage,
      } as any,
      sessionManager: {
        ensureSession,
        updateContext,
        getSession,
        getOrCreateSystemSession,
        addMessage,
        getMessages: vi.fn().mockReturnValue([]),
      } as any,
      askManager,
      dispatchTaskToAgent,
      directSendToModule,
      eventBus: new UnifiedEventBus(),
      runtime: {
        setCurrentSession: runtimeSetCurrentSession,
      },
    });

    await route({
      payload: {
        id: 'msg-3',
        channelId: 'qqbot',
        accountId: 'acc-1',
        type: 'direct',
        senderId: 'user-1',
        senderName: 'User 1',
        content: 'hello direct',
        timestamp: Date.now(),
        metadata: {},
      },
    });

    expect(dispatchTaskToAgent).not.toHaveBeenCalled();
    expect(directSendToModule).toHaveBeenCalledTimes(1);
    expect(directSendToModule).toHaveBeenCalledWith(
      'finger-system-agent',
      expect.objectContaining({
        prompt: 'hello direct',
        sessionId: 'system-session-2',
      }),
    );
    expect(runtimeSetCurrentSession).toHaveBeenCalledWith('system-session-2');
    expect(sendMessage).toHaveBeenCalledWith('qqbot', expect.objectContaining({
      to: 'user-1',
      text: expect.stringContaining('direct ok'),
    }));
  });

  it('skips direct sendReply when recent body update has already been pushed for same route', async () => {
    ChannelContextManager.getInstance().clearContext('qqbot');
    ChannelContextManager.getInstance().updateContext('qqbot', 'system', 'finger-system-agent');
    const askManager = new AskManager(5_000);
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'reply-dup-1' });
    const addMessage = vi.fn().mockResolvedValue(undefined);
    const ensureSession = vi.fn();
    const updateContext = vi.fn();
    const getSession = vi.fn().mockReturnValue({
      id: 'system-session-dup-1',
      context: {},
    });
    const getOrCreateSystemSession = vi.fn().mockReturnValue({ id: 'system-session-dup-1' });
    const dispatchTaskToAgent = vi.fn();
    const directSendToModule = vi.fn().mockResolvedValue({
      success: true,
      response: 'same final body',
    });
    const runtimeSetCurrentSession = vi.fn().mockReturnValue(true);

    const agentStatusSubscriber = {
      registerSession: vi.fn(),
      wasBodyUpdateRecentlySentForRoute: vi.fn().mockReturnValue(false),
      wasBodyUpdateRecentlySent: vi.fn().mockReturnValue(false),
      wasAnyBodyUpdateRecentlySentForRoute: vi.fn().mockReturnValue(true),
      markFinalReplySent: vi.fn(),
    };

    const route = createChannelBridgeHubRoute({
      channelBridgeManager: {
        sendMessage,
      } as any,
      sessionManager: {
        ensureSession,
        updateContext,
        getSession,
        getOrCreateSystemSession,
        addMessage,
        getMessages: vi.fn().mockReturnValue([]),
      } as any,
      askManager,
      dispatchTaskToAgent,
      directSendToModule,
      agentStatusSubscriber: agentStatusSubscriber as any,
      eventBus: new UnifiedEventBus(),
      runtime: {
        setCurrentSession: runtimeSetCurrentSession,
      },
    });

    await route({
      payload: {
        id: 'msg-dup-1',
        channelId: 'qqbot',
        accountId: 'acc-1',
        type: 'direct',
        senderId: 'user-1',
        senderName: 'User 1',
        content: 'hello direct',
        timestamp: Date.now(),
        metadata: {},
      },
    });

    expect(dispatchTaskToAgent).not.toHaveBeenCalled();
    expect(directSendToModule).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(agentStatusSubscriber.wasAnyBodyUpdateRecentlySentForRoute).toHaveBeenCalledTimes(1);
  });

  it('pre-marks final reply for dedup and clears mark when channel send fails', async () => {
    ChannelContextManager.getInstance().clearContext('qqbot');
    ChannelContextManager.getInstance().updateContext('qqbot', 'system', 'finger-system-agent');
    const askManager = new AskManager(5_000);
    const sendMessage = vi.fn().mockRejectedValue(new Error('send failed'));
    const addMessage = vi.fn().mockResolvedValue(undefined);
    const ensureSession = vi.fn();
    const updateContext = vi.fn();
    const getSession = vi.fn().mockReturnValue({
      id: 'system-session-send-fail',
      context: {},
    });
    const getOrCreateSystemSession = vi.fn().mockReturnValue({ id: 'system-session-send-fail' });
    const dispatchTaskToAgent = vi.fn();
    const directSendToModule = vi.fn().mockResolvedValue({
      success: true,
      response: 'final payload',
    });
    const runtimeSetCurrentSession = vi.fn().mockReturnValue(true);

    const agentStatusSubscriber = {
      registerSession: vi.fn(),
      wasBodyUpdateRecentlySentForRoute: vi.fn().mockReturnValue(false),
      wasBodyUpdateRecentlySent: vi.fn().mockReturnValue(false),
      wasAnyBodyUpdateRecentlySentForRoute: vi.fn().mockReturnValue(false),
      markFinalReplySent: vi.fn(),
      clearFinalReplySent: vi.fn(),
    };

    const route = createChannelBridgeHubRoute({
      channelBridgeManager: {
        sendMessage,
      } as any,
      sessionManager: {
        ensureSession,
        updateContext,
        getSession,
        getOrCreateSystemSession,
        addMessage,
        getMessages: vi.fn().mockReturnValue([]),
      } as any,
      askManager,
      dispatchTaskToAgent,
      directSendToModule,
      agentStatusSubscriber: agentStatusSubscriber as any,
      eventBus: new UnifiedEventBus(),
      runtime: {
        setCurrentSession: runtimeSetCurrentSession,
      },
    });

    await route({
      payload: {
        id: 'msg-send-fail',
        channelId: 'qqbot',
        accountId: 'acc-1',
        type: 'direct',
        senderId: 'user-1',
        senderName: 'User 1',
        content: 'trigger send fail',
        timestamp: Date.now(),
        metadata: {},
      },
    });

    expect(agentStatusSubscriber.markFinalReplySent).toHaveBeenCalledWith(
      'system-session-send-fail',
      'final payload',
    );
    expect(agentStatusSubscriber.clearFinalReplySent).toHaveBeenCalledWith('system-session-send-fail');
  });

  it('passes image inputItems to metadata and persists attachment summary', async () => {
    ChannelContextManager.getInstance().clearContext('qqbot');
    ChannelContextManager.getInstance().updateContext('qqbot', 'system', 'finger-system-agent');
    const askManager = new AskManager(5_000);
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'reply-4' });
    const addMessage = vi.fn().mockResolvedValue(undefined);
    const ensureSession = vi.fn();
    const updateContext = vi.fn();
    const getSession = vi.fn().mockReturnValue({
      id: 'system-session-3',
      context: {},
    });
    const getOrCreateSystemSession = vi.fn().mockReturnValue({ id: 'system-session-3' });
    const dispatchTaskToAgent = vi.fn();
    const directSendToModule = vi.fn().mockResolvedValue({
      success: true,
      response: 'ok',
    });

    const route = createChannelBridgeHubRoute({
      channelBridgeManager: {
        sendMessage,
      } as any,
      sessionManager: {
        ensureSession,
        updateContext,
        getSession,
        getOrCreateSystemSession,
        addMessage,
        getMessages: vi.fn().mockReturnValue([]),
      } as any,
      askManager,
      dispatchTaskToAgent,
      directSendToModule,
      eventBus: new UnifiedEventBus(),
      runtime: {},
    });

    await route({
      payload: {
        id: 'msg-4',
        channelId: 'qqbot',
        accountId: 'acc-1',
        type: 'direct',
        senderId: 'user-1',
        senderName: 'User 1',
        content: '请结合图片分析',
        attachments: [
          {
            type: 'image',
            url: '/tmp/fake-image-1.png',
            filename: 'fake-image-1.png',
          },
        ],
        timestamp: Date.now(),
        metadata: {},
      },
    });

    expect(directSendToModule).toHaveBeenCalledWith(
      'finger-system-agent',
      expect.objectContaining({
        prompt: '请结合图片分析',
        metadata: expect.objectContaining({
          inputItems: [
            expect.objectContaining({
              type: 'image',
              image_url: '/tmp/fake-image-1.png',
            }),
          ],
        }),
      }),
    );

    const userWrite = addMessage.mock.calls.find((call) => call[1] === 'user');
    expect(userWrite).toBeTruthy();
    expect(userWrite?.[3]).toMatchObject({
      metadata: expect.objectContaining({
        hasAttachments: true,
        attachmentCount: 1,
      }),
    });
  });

  it('converts local image attachment to data-url image inputItem', async () => {
    const localImagePath = `/tmp/fake-image-${Date.now()}.png`;
    writeFileSync(localImagePath, 'fake-image');
    try {
      ChannelContextManager.getInstance().clearContext('qqbot');
      ChannelContextManager.getInstance().updateContext('qqbot', 'system', 'finger-system-agent');
      const askManager = new AskManager(5_000);
      const sendMessage = vi.fn().mockResolvedValue({ messageId: 'reply-5' });
      const addMessage = vi.fn().mockResolvedValue(undefined);
      const ensureSession = vi.fn();
      const updateContext = vi.fn();
      const getSession = vi.fn().mockReturnValue({
        id: 'system-session-4',
        context: {},
      });
      const getOrCreateSystemSession = vi.fn().mockReturnValue({ id: 'system-session-4' });
      const dispatchTaskToAgent = vi.fn();
      const directSendToModule = vi.fn().mockResolvedValue({
        success: true,
        response: 'ok',
      });

      const route = createChannelBridgeHubRoute({
        channelBridgeManager: {
          sendMessage,
        } as any,
        sessionManager: {
          ensureSession,
          updateContext,
          getSession,
          getOrCreateSystemSession,
          addMessage,
          getMessages: vi.fn().mockReturnValue([]),
        } as any,
        askManager,
        dispatchTaskToAgent,
        directSendToModule,
        eventBus: new UnifiedEventBus(),
        runtime: {},
      });

      await route({
        payload: {
          id: 'msg-5',
          channelId: 'qqbot',
          accountId: 'acc-1',
          type: 'direct',
          senderId: 'user-1',
          senderName: 'User 1',
          content: '看这张图',
          attachments: [
            {
              type: 'image',
              url: localImagePath,
              filename: 'local-fake-image.png',
            },
          ],
          timestamp: Date.now(),
          metadata: {},
        },
      });

      expect(directSendToModule).toHaveBeenCalledWith(
        'finger-system-agent',
        expect.objectContaining({
          prompt: '看这张图',
          metadata: expect.objectContaining({
            inputItems: [
              expect.objectContaining({
                type: 'image',
                image_url: expect.stringMatching(/^data:image\/png;base64,/),
              }),
            ],
          }),
        }),
      );
    } finally {
      rmSync(localImagePath, { force: true });
    }
  });

  it('injects missing-attachment notice and suppresses kernelApiHistory for media-like prompt without attachment', async () => {
    ChannelContextManager.getInstance().clearContext('qqbot');
    ChannelContextManager.getInstance().updateContext('qqbot', 'system', 'finger-system-agent');
    const askManager = new AskManager(5_000);
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'reply-6' });
    const addMessage = vi.fn().mockResolvedValue(undefined);
    const ensureSession = vi.fn();
    const updateContext = vi.fn();
    const getSession = vi.fn().mockReturnValue({
      id: 'system-session-6',
      context: {},
    });
    const getOrCreateSystemSession = vi.fn().mockReturnValue({ id: 'system-session-6' });
    const dispatchTaskToAgent = vi.fn();
    const directSendToModule = vi.fn().mockResolvedValue({
      success: true,
      response: 'ok',
    });

    const route = createChannelBridgeHubRoute({
      channelBridgeManager: {
        sendMessage,
      } as any,
      sessionManager: {
        ensureSession,
        updateContext,
        getSession,
        getOrCreateSystemSession,
        addMessage,
        getMessages: vi.fn().mockReturnValue([
          { role: 'user', content: 'old context' },
          { role: 'assistant', content: 'old answer' },
        ]),
      } as any,
      askManager,
      dispatchTaskToAgent,
      directSendToModule,
      eventBus: new UnifiedEventBus(),
      runtime: {},
    });

    await route({
      payload: {
        id: 'msg-6',
        channelId: 'qqbot',
        accountId: 'acc-1',
        type: 'direct',
        senderId: 'user-1',
        senderName: 'User 1',
        content: '帮我描述这张图片内容',
        timestamp: Date.now(),
        metadata: {},
      },
    });

    expect(directSendToModule).toHaveBeenCalledWith(
      'finger-system-agent',
      expect.objectContaining({
        prompt: expect.stringContaining('当前这条消息未携带附件'),
        metadata: expect.not.objectContaining({
          kernelApiHistory: expect.anything(),
        }),
      }),
    );
  });

  it('pins project-agent session per channel and reuses it for follow-up "继续" turns', async () => {
    const channelId = 'qqbot-pin-session';
    const contextManager = ChannelContextManager.getInstance();
    contextManager.clearContext(channelId);
    contextManager.updateContext(
      channelId,
      'business',
      'finger-project-agent',
      undefined,
      { projectPath: '/tmp/project-pin' },
    );

    const askManager = new AskManager(5_000);
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'reply-pin-1' });
    const addMessage = vi.fn().mockResolvedValue(undefined);
    const ensureSession = vi.fn();
    const updateContext = vi.fn();
    const getSession = vi.fn((sessionId: string) => {
      if (sessionId === 'runtime-project-1') {
        return {
          id: 'runtime-project-1',
          projectPath: '/tmp/project-pin',
          context: { ownerAgentId: 'finger-project-agent' },
        };
      }
      return {
        id: sessionId,
        projectPath: '/tmp/project-pin',
        context: {},
      };
    });
    const getOrCreateSystemSession = vi.fn().mockReturnValue({ id: 'system-session-pin' });
    const dispatchTaskToAgent = vi.fn();
    const directSendToModule = vi.fn().mockResolvedValue({
      success: true,
      response: 'ok',
    });
    const listSessions = vi.fn()
      // first turn: has a matching runtime session for project agent
      .mockReturnValueOnce([
        {
          id: 'runtime-project-1',
          projectPath: '/tmp/project-pin',
          lastAccessedAt: new Date('2026-03-28T09:00:00.000Z').toISOString(),
          context: { ownerAgentId: 'finger-project-agent' },
        },
        {
          id: 'root-project-1',
          projectPath: '/tmp/project-pin',
          lastAccessedAt: new Date('2026-03-28T09:10:00.000Z').toISOString(),
          context: {},
        },
      ])
      // second turn: runtime list no longer exposes it; should still hit pinned session
      .mockReturnValueOnce([
        {
          id: 'root-project-1',
          projectPath: '/tmp/project-pin',
          lastAccessedAt: new Date('2026-03-28T09:12:00.000Z').toISOString(),
          context: {},
        },
      ]);

    const route = createChannelBridgeHubRoute({
      channelBridgeManager: {
        sendMessage,
      } as any,
      sessionManager: {
        ensureSession,
        updateContext,
        getSession,
        getOrCreateSystemSession,
        addMessage,
        getMessages: vi.fn().mockReturnValue([]),
        listSessions,
        findSessionsByProjectPath: vi.fn().mockReturnValue([{ id: 'root-project-1' }]),
      } as any,
      askManager,
      dispatchTaskToAgent,
      directSendToModule,
      eventBus: new UnifiedEventBus(),
      runtime: {
        setCurrentSession: vi.fn().mockReturnValue(true),
      },
    });

    await route({
      payload: {
        id: 'msg-pin-1',
        channelId,
        accountId: 'acc-pin',
        type: 'direct',
        senderId: 'user-pin',
        senderName: 'User Pin',
        content: '先继续当前任务',
        timestamp: Date.now(),
        metadata: {},
      },
    });

    await route({
      payload: {
        id: 'msg-pin-2',
        channelId,
        accountId: 'acc-pin',
        type: 'direct',
        senderId: 'user-pin',
        senderName: 'User Pin',
        content: '继续',
        timestamp: Date.now() + 1000,
        metadata: {},
      },
    });

    expect(directSendToModule).toHaveBeenCalledTimes(2);
    expect(directSendToModule).toHaveBeenNthCalledWith(
      1,
      'finger-project-agent',
      expect.objectContaining({ sessionId: 'runtime-project-1' }),
    );
    expect(directSendToModule).toHaveBeenNthCalledWith(
      2,
      'finger-project-agent',
      expect.objectContaining({ sessionId: 'runtime-project-1' }),
    );
  });
});
