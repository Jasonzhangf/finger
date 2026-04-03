export interface SyntheticToolResult {
  type: 'synthetic_error';
  error: string;
  abortReason: string;
  sessionId: string;
  timestamp: string;
}

export interface AbortEvent {
  sessionId: string;
  reason: string;
  timestamp: string;
  syntheticResult: SyntheticToolResult;
}

class AbortCausalityManager {
  private chain: AbortEvent[] = [];

  recordAbortion(event: AbortEvent): void {
    this.chain.push(event);
  }

  queryAbortChain(sessionId?: string): AbortEvent[] {
    if (!sessionId) {
      return [...this.chain];
    }
    return this.chain.filter((e) => e.sessionId === sessionId);
  }

  clearChain(): void {
    this.chain = [];
  }
}

export const abortCausality = new AbortCausalityManager();
