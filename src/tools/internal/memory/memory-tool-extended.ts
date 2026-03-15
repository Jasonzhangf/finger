/**
 * Memory Tool Extended - CACHE.md Support
 * 
 * Extends memory tool to support CACHE.md for short-term conversation tracking.
 * Provides automatic cache-to-memory compaction on reviewer approval.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { MemoryInput, MemoryOutput, MemoryEntry } from './memory-tool.js';

export interface ExtendedMemoryInput extends Omit<MemoryInput, 'action'> {
  action: MemoryInput['action'] | 'clear';
  target?: 'cache' | 'memory';
  cache_entry?: {
    timestamp: string;
    agent_id: string;
    session_id: string;
    role: 'user' | 'assistant';
    type: 'request' | 'response';
    content: string;
    summary?: string;
    finish_reason?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface ExtendedMemoryOutput extends MemoryOutput {
  cache_path?: string;
  memory_path?: string;
  summary?: string;
  content?: string;
}

/**
 * Get CACHE.md path for project
 */
function getCachePath(projectPath: string): string {
  return path.join(projectPath, 'CACHE.md');
}

/**
 * Get MEMORY.md path for project
 */
function getMemoryPath(projectPath: string): string {
  return path.join(projectPath, 'MEMORY.md');
}

/**
 * Format cache entry for CACHE.md
 */
function formatCacheEntry(entry: {
  timestamp: string;
  agent_id: string;
  session_id: string;
  role: 'user' | 'assistant';
  type: 'request' | 'response';
  content: string;
  summary?: string;
  finish_reason?: string;
}): string {
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

/**
 * Generate summary from cache content
 */
function generateCacheSummary(cacheContent: string): string {
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
    `**Summary**`,
    `Total entries: ${entries.length}`,
    ``,
    `**Key Entries**:`,
  ];

  // Take last 10 entries
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

/**
 * Execute extended memory operation with CACHE.md support
 */
export async function executeExtendedMemory(rawInput: unknown): Promise<ExtendedMemoryOutput> {
  const input = rawInput as ExtendedMemoryInput;
  const action = input.action;
  const target = input.target || 'cache';
  const projectPath = input.project_path || process.cwd();
  const cachePath = getCachePath(projectPath);
  const memoryPath = getMemoryPath(projectPath);

  // Handle cache-specific actions
  if (target === 'cache') {
    return await executeCacheAction(input, cachePath, memoryPath);
  }

  // Delegate to original memory tool for memory target
  // This will be handled by the existing memory-tool.ts
  return {
    ok: false,
    action,
    error: 'Memory target not yet implemented in extended version',
  };
}

/**
 * Execute cache-specific action
 */
async function executeCacheAction(
  input: ExtendedMemoryInput,
  cachePath: string,
  memoryPath: string
): Promise<ExtendedMemoryOutput> {
  try {
    switch (input.action) {
      case 'insert': {
        if (!input.cache_entry) {
          return { ok: false, action: 'insert', error: 'cache_entry is required' };
        }

        const entryText = formatCacheEntry(input.cache_entry);
        
        // Ensure cache file exists
        try {
          await fs.access(cachePath);
        } catch {
          await fs.mkdir(path.dirname(cachePath), { recursive: true });
          await fs.writeFile(cachePath, `# Conversation Cache\n\n`, 'utf-8');
        }

        // Append entry
        await fs.appendFile(cachePath, `${entryText}\n---\n\n`, 'utf-8');

        return { ok: true, action: 'insert', cache_path: cachePath };
      }

      case 'compact': {
        // Read CACHE.md
        let cacheContent = '';
        try {
          cacheContent = await fs.readFile(cachePath, 'utf-8');
        } catch {
          return { ok: true, action: 'compact', summary: 'No cache to compact' };
        }

        if (cacheContent.trim().length === 0) {
          return { ok: true, action: 'compact', summary: 'Cache is empty' };
        }

        // Generate summary (use provided or generate default)
        const summary = input.content || generateCacheSummary(cacheContent);

        // Write summary to MEMORY.md
        try {
          await fs.access(memoryPath);
        } catch {
          await fs.mkdir(path.dirname(memoryPath), { recursive: true });
          await fs.writeFile(memoryPath, `# Project Memory\n\n`, 'utf-8');
        }

        const timestamp = new Date().toISOString();
        const memoryEntry = `## [summary] CACHE Summary - ${timestamp}\n\n${summary}\n\n---\n\n`;
        await fs.appendFile(memoryPath, memoryEntry, 'utf-8');

        // Clear CACHE.md and write summary residue
        await fs.writeFile(cachePath, `# Conversation Cache\n\n## Last Summary\n\n${summary}\n\n`, 'utf-8');

        return { 
          ok: true, 
          action: 'compact', 
          content: summary,
          cache_path: cachePath, 
          memory_path: memoryPath 
        };
      }

      case 'clear': {
        await fs.writeFile(cachePath, `# Conversation Cache\n\n`, 'utf-8');
        return { ok: true, action: 'clear', cache_path: cachePath };
      }

      default:
        return { ok: false, action: input.action, error: 'Unknown action for cache target' };
    }
  } catch (error) {
    return { 
      ok: false, 
      action: input.action, 
      error: error instanceof Error ? error.message : String(error) 
    };
  }
}
