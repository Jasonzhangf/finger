import { describe, it, expect, vi } from 'vitest';
import { createChannelBridgeHubRoute } from '../../../src/server/modules/channel-bridge-hub-route.js';
import { AskManager } from '../../../src/orchestration/ask/ask-manager.js';
import { getChannelContextManager } from '../../../src/orchestration/channel-context-manager.js';
import { UnifiedEventBus } from '../../../src/runtime/event-bus.js';

describe('channel-bridge-hub-route user.ask async adaptation', () => {
  it('resolves pending ask for qqbot without dispatching a new task', async () => {
    getChannelContextManager().updateContext('qqbot', 'business', 'finger-project-agent');
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
    getChannelContextManager().updateContext('qqbot', 'business', 'finger-project-agent');
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

    expect(dispatchTaskToAgent).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('qqbot', expect.objectContaining({
      to: 'user-1',
      text: expect.stringContaining('处理失败，请稍后再试'),
    }));
  });

  it('routes direct user input to system module without dispatch queue when directSendToModule is available', async () => {
    getChannelContextManager().updateContext('qqbot', 'business', 'finger-project-agent');
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

  it('injects image attachment hints into prompt and persists attachments into session message', async () => {
    getChannelContextManager().updateContext('qqbot', 'business', 'finger-project-agent');
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
        prompt: expect.stringContaining('[图片1: fake-image-1.png]'),
      }),
    );

    const userWrite = addMessage.mock.calls.find((call) => call[1] === 'user');
    expect(userWrite).toBeTruthy();
    expect(userWrite?.[3]).toMatchObject({
      attachments: [
        expect.objectContaining({
          type: 'image',
          url: '/tmp/fake-image-1.png',
        }),
      ],
    });
  });
});
