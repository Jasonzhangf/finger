/**
 * CACHE.md Memory Interceptor for Agent Base Classes
 * 
 * Automatically writes user requests and assistant completions to CACHE.md
 * through the memory tool. This provides short-term conversation tracking
 * that can be summarized into long-term MEMORY.md on reviewer approval.
 */

import type { UnifiedAgentInput, UnifiedAgentOutput } from './unified-agent-types.js';
import type { MessageHub } from '../../orchestration/message-hub.js';


export interface CacheMemoryInterceptorConfig {
  enabled?: boolean;
  projectPath?: string;
  agentId: string;
  messageHub?: MessageHub;
}

export interface CacheEntry {
  timestamp: string;
  agent_id: string;
  session_id: string;
  role: 'user' | 'assistant';
  type: 'request' | 'response';
  content: string;
  summary?: string;
  task_id?: string;
  finish_reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Intercepts agent input/output and writes to CACHE.md via memory tool
 */
export class CacheMemoryInterceptor {
  private enabled: boolean;
  private projectPath: string;
  private agentId: string;
  private messageHub: MessageHub | null;

  constructor(config: CacheMemoryInterceptorConfig & { messageHub?: MessageHub }) {
    this.enabled = config.enabled !== false;
    this.projectPath = config.projectPath || process.cwd();
    this.agentId = config.agentId;
    this.messageHub = config.messageHub || null;
  }

  /**
   * Intercept user request and write to CACHE.md
   */
  async interceptRequest(input: UnifiedAgentInput): Promise<void> {
    if (!this.enabled) return;
    if (!input.text || input.text.trim().length === 0) return;

    const entry: CacheEntry = {
      timestamp: new Date().toISOString(),
      agent_id: this.agentId,
      session_id: input.sessionId || 'unknown',
      role: 'user',
      type: 'request',
      content: input.text,
      summary: input.text.slice(0, 200),
      task_id: input.metadata?.taskId as string || undefined,
      metadata: {
        tools: input.tools,
        roleProfile: input.roleProfile,
      },
    };

    await this.writeToCache(entry);
  }

  /**
   * Intercept assistant response and write to CACHE.md
   */
  async interceptResponse(output: UnifiedAgentOutput, input: UnifiedAgentInput): Promise<void> {
    if (!this.enabled) return;
    
    // Only write on successful completions
    if (!output.success) return;

    // Check finish_reason from metadata
    const finishReason = this.extractFinishReason(output!)!;
    if (finishReason !== 'stop') return;

    const entry: CacheEntry = {
      timestamp: new Date().toISOString(),
      agent_id: this.agentId,
      session_id: output.sessionId || input.sessionId || 'unknown',
      role: 'assistant',
      type: 'response',
      content: output.response || '',
      summary: output.response?.slice(0, 200),
      finish_reason: finishReason,
      metadata: {
        roleProfile: output.metadata?.roleProfile as string || input.roleProfile,
        tools: output.metadata?.tools as string[] || input.tools,
        latencyMs: output.latencyMs,
        messageId: output.messageId,
      },
    };

    await this.writeToCache(entry);
  }

  /**
   * Extract finish_reason from output metadata
   */
  private extractFinishReason(output: UnifiedAgentOutput): string | undefined {
    const metadata = output.metadata as Record<string, unknown> | undefined;
    if (!metadata) return undefined;

    // Direct finish_reason in metadata
    if (typeof metadata.finish_reason === 'string') {
      return metadata.finish_reason;
    }

    // Check round_trace for finish_reason
    if (Array.isArray(metadata.round_trace) && metadata.round_trace.length > 0) {
      const lastRound = metadata.round_trace[metadata.round_trace.length - 1];
      if (isRecord(lastRound) && typeof lastRound.finish_reason === 'string') {
        return lastRound.finish_reason;
      }
    }

    return undefined;
  }

  /**
   * Write entry to CACHE.md via memory tool
   */
  private async writeToCache(entry: CacheEntry): Promise<void> {
    try {
      // Use messageHub to dispatch memory tool if available
      if (this.messageHub) {
        await this.messageHub.routeToOutput('memory', {
          id: `cache-${Date.now()}`,
          type: 'fact',
          action: 'insert',
          target: 'cache',
          title: `${entry.role}: ${entry.type}`,
          content: this.formatEntry(entry),
          tags: ['cache', entry.role, entry.type, entry.agent_id],
        });
      } else {
        // Fallback: direct file write (simplified)
        // In production, always use messageHub to dispatch to memory tool
        console.warn('[CacheMemoryInterceptor] No messageHub available, skipping cache write');
      }
    } catch (error) {
      console.error('[CacheMemoryInterceptor] Failed to write to cache:', error);
    }
  }

  /**
   * Format entry for storage
   */
  private formatEntry(entry: CacheEntry): string {
    const lines = [
      `### ${entry.role.toUpperCase()} ${entry.type.toUpperCase()}`,
      `**Time**: ${entry.timestamp}`,
      `**Agent**: ${entry.agent_id}`,
      `**Session**: ${entry.session_id}`,
      ``,
      entry.content,
      ``,
    ];

    if (entry.summary) {
      lines.push(`**Summary**: ${entry.summary}`);
      lines.push(``);
    }

    if (entry.finish_reason) {
      lines.push(`**Finish Reason**: ${entry.finish_reason}`);
      lines.push(``);
    }

    return lines.join('\n');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
