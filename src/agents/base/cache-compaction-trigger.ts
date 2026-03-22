/**
 * Cache Compaction Trigger
 * 
 * Triggers automatic CACHE.md → MEMORY.md compaction on reviewer approval.
 * This is the Phase 4 implementation of the memory management system.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { logger } from '../../core/logger.js';
import { createConsoleLikeLogger } from '../../core/logger/console-like.js';

const clog = createConsoleLikeLogger('CacheCompactionTrigger');

const log = logger.module('CacheCompactionTrigger');

export interface CompactionTriggerConfig {
  enabled?: boolean;
  projectPath?: string;
  messageHub?: MessageHub;
}

/**
 * Trigger cache compaction on reviewer approval
 */
export class CacheCompactionTrigger {
  private enabled: boolean;
  private projectPath: string;
  private messageHub?: MessageHub;

  constructor(config: CompactionTriggerConfig) {
    this.enabled = config.enabled !== false;
    this.projectPath = config.projectPath || process.cwd();
    this.messageHub = config.messageHub;
  }

  /**
   * Trigger compaction on reviewer approval
   */
  async triggerOnApproval(options: {
    sessionId: string;
    agentId: string;
    reviewerOutcome: 'approved' | 'rejected';
    summary?: string;
  }): Promise<boolean> {
    if (!this.enabled) return false;
    if (options.reviewerOutcome !== 'approved') return false;

    try {
      // Dispatch to memory tool for compaction
      if (this.messageHub) {
        await this.messageHub.routeToOutput('memory', {
          id: `compact-${Date.now()}`,
          type: 'summary',
          action: 'compact',
          target: 'cache',
          title: 'Reviewer Approval - Cache Compaction',
          content: options.summary || this.generateDefaultSummary(options),
          tags: ['auto-compact', 'reviewer-approved', options.sessionId, options.agentId],
        });
      } else {
        // Fallback: direct compaction
        await this.directCompact(options);
      }

      return true;
    } catch (error) {
      clog.error('[CacheCompactionTrigger] Failed to trigger compaction:', error);
      return false;
    }
  }

  /**
   * Generate default summary from reviewer approval
   */
  private generateDefaultSummary(options: {
    sessionId: string;
    agentId: string;
    reviewerOutcome: string;
  }): string {
    const timestamp = new Date().toISOString();
    return `**Reviewer Approval** - ${timestamp}

**Session**: ${options.sessionId}
**Agent**: ${options.agentId}
**Outcome**: ${options.reviewerOutcome}

Task reviewed and approved by reviewer agent. Cache has been summarized to long-term memory.`;
  }

  /**
   * Direct compaction without messageHub
   */
  private async directCompact(options: { summary?: string }): Promise<void> {
    const cachePath = path.join(this.projectPath, 'CACHE.md');
    const memoryPath = path.join(this.projectPath, 'MEMORY.md');

    // Read cache
    let cacheContent = '';
    try {
      cacheContent = await fs.readFile(cachePath, 'utf-8');
    } catch {
      return; // No cache to compact
    }

    if (cacheContent.trim().length === 0) return;

    // Generate summary
    const summary = options.summary || this.extractSummary(cacheContent);

    // Write to memory
    try {
      await fs.access(memoryPath);
    } catch {
      await fs.mkdir(path.dirname(memoryPath), { recursive: true });
      await fs.writeFile(memoryPath, `# Project Memory\n\n`, 'utf-8');
    }

    const timestamp = new Date().toISOString();
    const memoryEntry = `## [summary] CACHE Summary - ${timestamp}\n\n${summary}\n\n---\n\n`;
    await fs.appendFile(memoryPath, memoryEntry, 'utf-8');

    // Clear cache and write residue
    await fs.writeFile(cachePath, `# Conversation Cache\n\n## Last Summary\n\n${summary}\n\n`, 'utf-8');
  }

  /**
   * Extract summary from cache content
   */
  private extractSummary(cacheContent: string): string {
    const lines = cacheContent.split('\n');
    const entries: string[] = [];
    let currentEntry: string[] = [];

    for (const line of lines) {
      if (line.match(/^### (USER|ASSISTANT)/)) {
        if (currentEntry.length > 0) {
          entries.push(currentEntry.join('\n'));
        }
        currentEntry = [line];
      } else {
        currentEntry.push(line);
      }
    }

    if (currentEntry.length > 0) {
      entries.push(currentEntry.join('\n'));
    }

    const summaryLines = [
      `**Auto Summary**`,
      `Total entries: ${entries.length}`,
      ``,
      `**Recent Activity**`,
    ];

    const recentEntries = entries.slice(-10);
    for (const entry of recentEntries) {
      const match = entry.match(/^### (\w+) (\w+)/);
      if (match) {
        const role = match[1];
        const type = match[2];
        summaryLines.push(`- [${role}] ${type}`);
      }
    }

    return summaryLines.join('\n');
  }
}
