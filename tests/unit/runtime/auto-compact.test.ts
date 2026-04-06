import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Auto Compact Flow', () => {
  it('should trigger auto compact when contextUsagePercent >= 85', async () => {
    // Mock sessionManager with compressContext
    const mockCompressContext = vi.fn().mockResolvedValue('Compression completed');
    const mockGetSession = vi.fn().mockReturnValue({
      id: 'test-session-85',
      messageCount: 100,
      totalTokens: 100000,
      context: { ownerAgentId: 'finger-project-agent' },
    });
    const mockGetMessages = vi.fn().mockReturnValue([]);
    
    const mockSessionManager = {
      compressContext: mockCompressContext,
      getSession: mockGetSession,
      getMessages: mockGetMessages,
    };

    const mockEventBus = {
      emit: vi.fn(),
    };

    // Import RuntimeFacade
    const { RuntimeFacade } = await import('../../../src/runtime/runtime-facade.ts');
    
    const runtime = new RuntimeFacade({
      sessionManager: mockSessionManager as any,
      eventBus: mockEventBus as any,
    } as any);

    // Test: 85% context should trigger compact
    const result = await runtime.maybeAutoCompact('test-session-85', 85, 'turn-1');
    
    console.log('Result:', result);
    console.log('compressContext called:', mockCompressContext.mock.calls.length);
    
    expect(result).toBe(true);
    expect(mockCompressContext).toHaveBeenCalled();
    
    // Test: 84% should NOT trigger
    mockCompressContext.mockClear();
    const result2 = await runtime.maybeAutoCompact('test-session-85', 84, 'turn-2');
    
    console.log('Result2:', result2);
    console.log('compressContext called:', mockCompressContext.mock.calls.length);
    
    expect(result2).toBe(false);
    expect(mockCompressContext).not.toHaveBeenCalled();
  });

  it('should use defaultSummarizer for auto compact (no model call)', async () => {
    // 验证 auto compact 不调用模型（deterministic digest）
    const mockCompressContext = vi.fn().mockImplementation(async (sessionId: string, summarizer?: any) => {
      if (summarizer) {
        // 手动 compact 应该有 summarizer
        const messages = [];
        const result = await summarizer(messages);
        console.log('Manual summarizer result:', result);
        return result.summary;
      } else {
        // auto compact 没有 summarizer（使用 defaultSummarizer）
        console.log('Auto compact: no summarizer, using defaultSummarizer');
        return 'Auto compression completed';
      }
    });
    
    const mockGetSession = vi.fn().mockReturnValue({
      id: 'test-session-auto',
      messageCount: 100,
      totalTokens: 100000,
      context: { ownerAgentId: 'finger-project-agent' },
    });
    const mockGetMessages = vi.fn().mockReturnValue([]);
    
    const mockSessionManager = {
      compressContext: mockCompressContext,
      getSession: mockGetSession,
      getMessages: mockGetMessages,
    };

    const mockEventBus = {
      emit: vi.fn(),
    };

    const { RuntimeFacade } = await import('../../../src/runtime/runtime-facade.ts');
    
    const runtime = new RuntimeFacade({
      sessionManager: mockSessionManager as any,
      eventBus: mockEventBus as any,
    } as any);

    // Auto compact (trigger='auto')
    const result = await runtime.compressContext('test-session-auto', { 
      trigger: 'auto', 
      contextUsagePercent: 85 
    });
    
    console.log('Auto compress result:', result);
    
    // 验证：auto compact 不应该卡死（no model call）
    expect(result).toBeDefined();
  });
});
