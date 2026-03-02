import type {
  ChatCodexRunContext,
  ChatCodexRunResult,
  ChatCodexRunner,
  ChatCodexRunnerInterruptResult,
  ChatCodexRunnerSessionState,
  KernelInputItem,
} from '../../../agents/finger-general/finger-general-module.js';

export type ChatCodexRunnerController = ChatCodexRunner & {
  listSessionStates(sessionId?: string, providerId?: string): ChatCodexRunnerSessionState[];
  interruptSession(sessionId: string, providerId?: string): ChatCodexRunnerInterruptResult[];
};

/**
 * Adaptive runner that switches between real and mock based on a predicate.
 */
export class AdaptiveChatCodexRunner implements ChatCodexRunnerController {
  private readonly realRunner: ChatCodexRunnerController;
  private readonly mockRunner: ChatCodexRunnerController;
  private readonly shouldUseMock: () => boolean;

  constructor(realRunner: ChatCodexRunnerController, mockRunner: ChatCodexRunnerController, shouldUseMock: () => boolean) {
    this.realRunner = realRunner;
    this.mockRunner = mockRunner;
    this.shouldUseMock = shouldUseMock;
  }

  runTurn(text: string, items?: KernelInputItem[], context?: ChatCodexRunContext): Promise<ChatCodexRunResult> {
    return (this.shouldUseMock() ? this.mockRunner : this.realRunner).runTurn(text, items, context);
  }

  listSessionStates(sessionId?: string, providerId?: string): ChatCodexRunnerSessionState[] {
    return (this.shouldUseMock() ? this.mockRunner : this.realRunner).listSessionStates(sessionId, providerId);
  }

  interruptSession(sessionId: string, providerId?: string): ChatCodexRunnerInterruptResult[] {
    return (this.shouldUseMock() ? this.mockRunner : this.realRunner).interruptSession(sessionId, providerId);
  }
}
