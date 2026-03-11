/**
 * Memory Tool - 基于 Markdown 的记忆系统
 * 
 * 存储位置:
 * - 项目记忆: {projectPath}/MEMORY.md
 * - 系统记忆: ~/.finger/system/MEMORY.md
 * 
 * 支持: insert, search, list, compact, edit, delete
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { FINGER_PATHS } from '../../../core/finger-paths.js';
import { InternalTool } from '../types.js';

export interface MemoryEntry {
  id: string;
  timestamp: string;
  type: 'fact' | 'decision' | 'error' | 'discovery' | 'preference' | 'instruction' | 'task' | 'summary';
  title: string;
  content: string;
  tags: string[];
  project?: string;
}

export interface MemoryInput {
  action: 'insert' | 'search' | 'list' | 'compact' | 'edit' | 'delete';
  scope?: 'project' | 'system';
  project_path?: string;
  type?: MemoryEntry['type'];
  title?: string;
  content?: string;
  tags?: string[];
  query?: string;
  limit?: number;
  type_filter?: MemoryEntry['type'];
  since?: string;
  until?: string;
  entry_id?: string;
  updates?: Partial<MemoryEntry>;
  caller_agent_id?: string;
  is_system_agent?: boolean;
}

export interface MemoryOutput {
  ok: boolean;
  action: string;
  entry?: MemoryEntry;
  entries?: MemoryEntry[];
  error?: string;
}

const SYSTEM_MEMORY_PATH = path.join(FINGER_PATHS.home, 'system', 'MEMORY.md');

function getMemoryPath(scope: 'project' | 'system', projectPath?: string): string {
  if (scope === 'system') {
    return SYSTEM_MEMORY_PATH;
  }
  return path.join(projectPath || process.cwd(), 'MEMORY.md');
}

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `mem-${timestamp}-${random}`;
}

function parseMemoryFile(content: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const lines = content.split('\n');
  let currentEntry: Partial<MemoryEntry> | null = null;
  let contentLines: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^## \[(\w+)\] (.+?) \{#(mem-[a-z0-9-]+)\}$/);
    if (headerMatch) {
      if (currentEntry && currentEntry.id) {
        entries.push({
          ...currentEntry,
          content: contentLines.join('\n').trim(),
        } as MemoryEntry);
      }
      currentEntry = {
        id: headerMatch[3],
        type: headerMatch[1] as MemoryEntry['type'],
        title: headerMatch[2],
      };
      contentLines = [];
      continue;
    }

    if (currentEntry) {
      const tsMatch = line.match(/^> timestamp: `([^`]+)`$/);
      if (tsMatch) {
        currentEntry.timestamp = tsMatch[1];
        continue;
      }

      const tagsMatch = line.match(/^> tags: (.+)$/);
      if (tagsMatch) {
        currentEntry.tags = tagsMatch[1].split(',').map(t => t.trim().replace(/`/g, ''));
        continue;
      }

      if (!line.startsWith('>') && !line.startsWith('---')) {
        contentLines.push(line);
      }
    }
  }

  if (currentEntry && currentEntry.id) {
    entries.push({
      ...currentEntry,
      content: contentLines.join('\n').trim(),
    } as MemoryEntry);
  }

  return entries;
}

function serializeEntry(entry: MemoryEntry): string {
  const lines: string[] = [
    `## [${entry.type}] ${entry.title} {#${entry.id}}`,
    `> timestamp: \`${entry.timestamp}\``,
  ];

  if (entry.tags.length > 0) {
    lines.push(`> tags: ${entry.tags.map(t => `\`${t}\``).join(', ')}`);
  }

  lines.push('', entry.content, '');
  return lines.join('\n');
}

function serializeMemoryFile(entries: MemoryEntry[]): string {
  const header = `# Memory

> Last updated: ${new Date().toISOString()}

---

`;
  return header + entries.map(serializeEntry).join('\n---\n');
}

function fuzzyMatch(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

function scoreMatch(entry: MemoryEntry, query: string): number {
  const lowerQuery = query.toLowerCase();
  let score = 0;
  if (entry.title.toLowerCase().includes(lowerQuery)) score += 10;
  if (entry.content.toLowerCase().includes(lowerQuery)) score += 5;
  for (const tag of entry.tags) {
    if (tag.toLowerCase().includes(lowerQuery)) score += 3;
  }
  return score;
}

export const memoryTool: InternalTool<unknown, MemoryOutput> = {
  name: 'memory',
  description: 'Manage agent memory in MEMORY.md. Actions: insert, search, list, compact, edit, delete. Scope: project (default) or system.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['insert', 'search', 'list', 'compact', 'edit', 'delete'] },
      scope: { type: 'string', enum: ['project', 'system'] },
      project_path: { type: 'string' },
      type: { type: 'string', enum: ['fact', 'decision', 'error', 'discovery', 'preference', 'instruction', 'task', 'summary'] },
      title: { type: 'string' },
      content: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      query: { type: 'string' },
      limit: { type: 'number' },
      type_filter: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      entry_id: { type: 'string' },
      updates: { type: 'object' },
      caller_agent_id: { type: 'string' },
      is_system_agent: { type: 'boolean' },
    },
    required: ['action'],
  },
  execute: async (rawInput: unknown): Promise<MemoryOutput> => {
    const input = rawInput as MemoryInput;
    const scope = input.scope || 'project';
    const memoryPath = getMemoryPath(scope, input.project_path);

    try {
      try {
        await fs.access(memoryPath);
      } catch {
        if (input.action === 'insert') {
          await fs.mkdir(path.dirname(memoryPath), { recursive: true });
          await fs.writeFile(memoryPath, serializeMemoryFile([]), 'utf-8');
        } else {
          return { ok: true, action: input.action, entries: [] };
        }
      }

      const fileContent = await fs.readFile(memoryPath, 'utf-8');
      const entries = parseMemoryFile(fileContent);

      switch (input.action) {
        case 'insert': {
          if (!input.content) return { ok: false, action: 'insert', error: 'content is required' };

          const entry: MemoryEntry = {
            id: generateId(),
            timestamp: new Date().toISOString(),
            type: input.type || 'fact',
            title: input.title || input.content.slice(0, 50),
            content: input.content,
            tags: input.tags || [],
          };

          entries.unshift(entry);
          await fs.writeFile(memoryPath, serializeMemoryFile(entries), 'utf-8');
          return { ok: true, action: 'insert', entry };
        }

        case 'search': {
          if (!input.query) return { ok: false, action: 'search', error: 'query is required' };

          const results = entries
            .filter(e => fuzzyMatch(e.title, input.query!) || fuzzyMatch(e.content, input.query!))
            .map(e => ({ ...e, _score: scoreMatch(e, input.query!) }))
            .sort((a, b) => (b as any)._score - (a as any)._score)
            .slice(0, input.limit || 10);

          return { ok: true, action: 'search', entries: results };
        }

        case 'list': {
          let filtered = entries;
          if (input.type_filter) filtered = filtered.filter(e => e.type === input.type_filter);
          if (input.since) filtered = filtered.filter(e => e.timestamp >= input.since!);
          if (input.until) filtered = filtered.filter(e => e.timestamp <= input.until!);
          if (input.limit) filtered = filtered.slice(0, input.limit);
          return { ok: true, action: 'list', entries: filtered };
        }

        case 'compact': {
          const keepCount = input.limit || 50;
          if (entries.length <= keepCount) return { ok: true, action: 'compact', entries };

          const kept = entries.slice(0, keepCount);
          const removed = entries.slice(keepCount);

          const summaryEntry: MemoryEntry = {
            id: generateId(),
            timestamp: new Date().toISOString(),
            type: 'summary',
            title: `Compacted ${removed.length} entries`,
            content: `Removed ${removed.length} older entries.`,
            tags: ['compact'],
          };

          kept.push(summaryEntry);
          await fs.writeFile(memoryPath, serializeMemoryFile(kept), 'utf-8');
          return { ok: true, action: 'compact', entry: summaryEntry, entries: kept };
        }

        case 'edit': {
          if (scope === 'system' && !input.is_system_agent && input.caller_agent_id !== 'finger-system-agent') {
            return { ok: false, action: 'edit', error: 'Only system agent can edit system memory' };
          }
          if (!input.entry_id) return { ok: false, action: 'edit', error: 'entry_id is required' };

          const index = entries.findIndex(e => e.id === input.entry_id);
          if (index === -1) return { ok: false, action: 'edit', error: 'Entry not found' };

          entries[index] = { ...entries[index], ...input.updates, id: entries[index].id, timestamp: new Date().toISOString() };
          await fs.writeFile(memoryPath, serializeMemoryFile(entries), 'utf-8');
          return { ok: true, action: 'edit', entry: entries[index] };
        }

        case 'delete': {
          if (scope === 'system' && !input.is_system_agent && input.caller_agent_id !== 'finger-system-agent') {
            return { ok: false, action: 'delete', error: 'Only system agent can delete system memory' };
          }
          if (!input.entry_id) return { ok: false, action: 'delete', error: 'entry_id is required' };

          const index = entries.findIndex(e => e.id === input.entry_id);
          if (index === -1) return { ok: false, action: 'delete', error: 'Entry not found' };

          const deleted = entries.splice(index, 1)[0];
          await fs.writeFile(memoryPath, serializeMemoryFile(entries), 'utf-8');
          return { ok: true, action: 'delete', entry: deleted };
        }

        default:
          return { ok: false, action: input.action, error: `Unknown action` };
      }
    } catch (err) {
      return { ok: false, action: input.action, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
