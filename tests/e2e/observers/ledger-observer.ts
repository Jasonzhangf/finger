/**
 * Ledger Observer for E2E tests
 * Observes ledger file events for testing agent behavior
 */

import { promises as fs } from 'fs';
import { resolveLedgerPath, normalizeRootDir } from '../../../src/runtime/context-ledger-memory-helpers.js';
import { waitForCondition } from './utils.js';
import { logger } from '../../../src/core/logger.js';

const log = logger.module('LedgerObserver');

export interface LedgerEvent {
  id: string;
  event_type: string;
  timestamp_ms: number;
  payload: Record<string, unknown>;
}

/**
 * Read JSON lines from a file
 */
async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    if (content.trim().length === 0) return [];
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export interface LedgerObserverOptions {
  sessionId: string;
  agentId: string;
  mode?: string;
}

/**
 * Ledger Observer
 * Monitors ledger file for new events
 */
export class LedgerObserver {
  private readonly rootDir: string;
  private readonly sessionId: string;
  private readonly agentId: string;
  private readonly mode: string;
  
  private startOffset: number = 0;
  private startLineCount: number = 0;
  private isObserving: boolean = false;
  private eventCache: LedgerEvent[] = [];

  constructor(sessionRootDir: string, options: LedgerObserverOptions);
  constructor(sessionRootDir: string, sessionId: string, agentId?: string, mode?: string);
  constructor(
    sessionRootDir: string,
    sessionIdOrOptions: string | LedgerObserverOptions,
    agentId?: string,
    mode?: string
  ) {
    this.rootDir = normalizeRootDir(sessionRootDir);
    
    if (typeof sessionIdOrOptions === 'object') {
      this.sessionId = sessionIdOrOptions.sessionId;
      this.agentId = sessionIdOrOptions.agentId;
      this.mode = sessionIdOrOptions.mode ?? 'main';
    } else {
      this.sessionId = sessionIdOrOptions;
      this.agentId = agentId ?? 'default';
      this.mode = mode ?? 'main';
    }
    
    log.debug('LedgerObserver created', { 
      rootDir: this.rootDir, 
      sessionId: this.sessionId, 
      agentId: this.agentId,
      mode: this.mode 
    });
  }

  private getLedgerPath(): string {
    return resolveLedgerPath(this.rootDir, this.sessionId, this.agentId, this.mode);
  }

  /**
   * Start observing - record current file position as offset
   */
  start(): void {
    this.isObserving = true;
    this.eventCache = [];
    log.debug('LedgerObserver started', { ledgerPath: this.getLedgerPath() });
  }

  /**
   * Stop observing
   */
  stop(): void {
    this.isObserving = false;
    log.debug('LedgerObserver stopped');
  }

  /**
   * Get new events since start() was called
   */
  async getNewEvents(): Promise<LedgerEvent[]> {
    const ledgerPath = this.getLedgerPath();
    
    interface LedgerEntryFile {
      id: string;
      event_type: string;
      timestamp_ms: number;
      payload: unknown;
    }
    
    const entries = await readJsonLines<LedgerEntryFile>(ledgerPath);
    
    // Skip events we've already seen
    const newEvents = entries.slice(this.startOffset);
    
    // Update offset for next call
    this.startOffset = entries.length;
    
    // Cache for timeline
    const events: LedgerEvent[] = newEvents.map(entry => ({
      id: entry.id,
      event_type: entry.event_type,
      timestamp_ms: entry.timestamp_ms,
      payload: (entry.payload as Record<string, unknown>) ?? {}
    }));
    
    this.eventCache.push(...events);
    
    return events;
  }

  /**
   * Wait for a specific event type to occur
   */
  async assertEventHappened(eventType: string, timeoutMs: number): Promise<void> {
    await waitForCondition(
      async () => {
        const events = await this.getNewEvents();
        return events.some(e => e.event_type === eventType);
      },
      timeoutMs,
      `Event type "${eventType}" not found within ${timeoutMs}ms`
    );
  }

  /**
   * Wait for a tool to be called (tool_call event type)
   */
  async assertToolCalled(toolName: string, timeoutMs: number): Promise<void> {
    await waitForCondition(
      async () => {
        const events = await this.getNewEvents();
        return events.some(e => 
          e.event_type === 'tool_call' && 
          (e.payload?.tool_name === toolName || e.payload?.name === toolName)
        );
      },
      timeoutMs,
      `Tool "${toolName}" not called within ${timeoutMs}ms`
    );
  }

  /**
   * Get all events observed so far (timeline)
   */
  getEventTimeline(): LedgerEvent[] {
    return [...this.eventCache];
  }

  /**
   * Reset observer state
   */
  reset(): void {
    this.startOffset = 0;
    this.startLineCount = 0;
    this.eventCache = [];
    log.debug('LedgerObserver reset');
  }

  /**
   * Get current ledger file path for debugging
   */
  getLedgerPathDebug(): string {
    return this.getLedgerPath();
  }
}
