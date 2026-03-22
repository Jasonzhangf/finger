/**
 * Memory Tool - 基于 Markdown + 语义搜索的记忆系统
 *
 * 存储位置:
 * - 项目记忆: {projectPath}/MEMORY.md
 * - 系统记忆: ~/.finger/system/MEMORY.md
 *
 * 特性:
 * - MEMORY.md 是唯一真源 (Single Source of Truth)
 * - 支持 insert 时自动索引
 * - 支持语义搜索 (embedding + Milvus Lite)
 * - compact 保留原始条目，只添加 summary
 *
 * 支持: insert, search, list, compact, edit, delete, reindex
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { FINGER_PATHS } from '../../../core/finger-paths.js';
import { InternalTool } from '../types.js';
import { getEmbeddingAdapter } from './embedding-adapter.js';
import { getMilvusAdapter, resetMilvusAdapter } from './milvus-adapter.js';
import { loadMemoryConfig } from './memory-config.js';
import { logger } from '../../../core/logger.js';

const log = logger.module('index');

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
  action: 'insert' | 'search' | 'list' | 'compact' | 'edit' | 'delete' | 'reindex';
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
  indexed_count?: number;
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
          id: currentEntry.id,
          type: currentEntry.type!,
          title: currentEntry.title!,
          timestamp: currentEntry.timestamp || '',
          content: contentLines.join('\n').trim(),
          tags: currentEntry.tags || [],
        });
      }
      currentEntry = {
        id: headerMatch[3],
        type: headerMatch[1] as MemoryEntry['type'],
        title: headerMatch[2],
        tags: [],
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
      id: currentEntry.id,
      type: currentEntry.type!,
      title: currentEntry.title!,
      timestamp: currentEntry.timestamp || '',
      content: contentLines.join('\n').trim(),
      tags: currentEntry.tags || [],
    });
  }

  return entries;
}

function serializeEntry(entry: MemoryEntry): string {
  const lines: string[] = [
    `## [${entry.type}] ${entry.title} {#${entry.id}}`,
    `> timestamp: \`${entry.timestamp}\``,
  ];

  if (entry.tags && entry.tags.length > 0) {
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

async function indexEntry(
  entry: MemoryEntry,
  scope: 'project' | 'system',
  projectPath?: string
): Promise<void> {
  try {
    const embeddingAdapter = getEmbeddingAdapter();
    const milvusAdapter = getMilvusAdapter(embeddingAdapter);

    const textToEmbed = `${entry.title}\n${entry.content}`;
    const { embedding } = await embeddingAdapter.embed(textToEmbed);

    await milvusAdapter.insert({
      id: entry.id,
      embedding,
      metadata: {
        title: entry.title,
        content: entry.content,
        type: entry.type,
        tags: entry.tags.join(','),
        timestamp: entry.timestamp,
        scope,
        projectPath,
      },
    });
  } catch (error) {
    console.error('[Memory] Failed to index entry:', entry.id, error);
  }
}

async function semanticSearch(
  query: string,
  scope: 'project' | 'system',
  projectPath?: string,
  limit: number = 10
): Promise<Array<{ id: string; score: number }>> {
  try {
    const embeddingAdapter = getEmbeddingAdapter();
    const milvusAdapter = getMilvusAdapter(embeddingAdapter);

    const { embedding } = await embeddingAdapter.embed(query);
    const results = await milvusAdapter.search(embedding, scope, projectPath, limit);

    return results.map(r => ({ id: r.id, score: r.score }));
  } catch (error) {
    console.error('[Memory] Semantic search failed:', error);
    return [];
  }
}

export const memoryTool: InternalTool<unknown, MemoryOutput> = {
  name: 'memory',
  description: 'Manage agent memory in MEMORY.md with semantic search. Actions: insert, search, list, compact, edit, delete, reindex. Scope: project (default) or system.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['insert', 'search', 'list', 'compact', 'edit', 'delete', 'reindex'] },
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
      loadMemoryConfig();

      try {
        await fs.access(memoryPath);
      } catch {
        if (input.action === 'insert' || input.action === 'reindex') {
          await fs.mkdir(path.dirname(memoryPath), { recursive: true });
          await fs.writeFile(memoryPath, serializeMemoryFile([]), 'utf-8');
        } else {
          return { ok: true, action: input.action, entries: [] };
        }
      }

      const fileContent = await fs.readFile(memoryPath, 'utf-8');
      let entries = parseMemoryFile(fileContent);

      switch (input.action) {
        case 'insert': {
          if (!input.content) return { ok: false, action: 'insert', error: 'content is required' };
          if (input.content.trim().length < 5) {
            return { ok: false, action: 'insert', error: 'content must be at least 5 meaningful characters' };
          }
          const title = input.title || input.content.slice(0, 50);
          if (/^(System entry|Updated)$/i.test(title.trim())) {
            return { ok: false, action: 'insert', error: 'title must be meaningful' };
          }

          const entry: MemoryEntry = {
            id: generateId(),
            timestamp: new Date().toISOString(),
            type: input.type || 'fact',
            title: title,
            content: input.content,
            tags: input.tags || [],
          };

          entries.unshift(entry);
          await fs.writeFile(memoryPath, serializeMemoryFile(entries), 'utf-8');
          indexEntry(entry, scope, input.project_path).catch(() => {});

          return { ok: true, action: 'insert', entry };
        }

        case 'search': {
          if (!input.query) return { ok: false, action: 'search', error: 'query is required' };

          const semanticResults = await semanticSearch(
            input.query,
            scope,
            input.project_path,
            input.limit || 10
          );

          if (semanticResults.length > 0) {
            const idToScore = new Map(semanticResults.map(r => [r.id, r.score]));
            const matchedEntries = entries
              .filter(e => idToScore.has(e.id))
              .sort((a, b) => (idToScore.get(b.id) || 0) - (idToScore.get(a.id) || 0));
            return { ok: true, action: 'search', entries: matchedEntries };
          }

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
          const config = loadMemoryConfig();
          const threshold = config.compact.threshold;
          const keepRecent = config.compact.keepRecent;

          if (entries.length <= threshold) {
            return { ok: true, action: 'compact', entries };
          }

          const olderEntries = entries.slice(keepRecent);
          if (olderEntries.length === 0) {
            return { ok: true, action: 'compact', entries };
          }

          const summaryEntry: MemoryEntry = {
            id: generateId(),
            timestamp: new Date().toISOString(),
            type: 'summary',
            title: `Memory Summary - ${olderEntries.length} older entries`,
            content: `Summary of ${olderEntries.length} entries (kept in full for reference):\n\n${
              olderEntries.slice(0, 10).map(e => `- [${e.type}] ${e.title}`).join('\n')
            }${olderEntries.length > 10 ? `\n... and ${olderEntries.length - 10} more` : ''}`,
            tags: ['compact', 'summary'],
          };

          entries.push(summaryEntry);
          await fs.writeFile(memoryPath, serializeMemoryFile(entries), 'utf-8');
          indexEntry(summaryEntry, scope, input.project_path).catch(() => {});

          return { ok: true, action: 'compact', entry: summaryEntry, entries };
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
          indexEntry(entries[index], scope, input.project_path).catch(() => {});

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

          try {
            const embeddingAdapter = getEmbeddingAdapter();
            const milvusAdapter = getMilvusAdapter(embeddingAdapter);
            await milvusAdapter.delete(input.entry_id);
          } catch (error) {
            console.error('[Memory] Failed to delete from vector index:', error);
          }

          return { ok: true, action: 'delete', entry: deleted };
        }

        case 'reindex': {
          let indexedCount = 0;
          const embeddingAdapter = getEmbeddingAdapter();
          const milvusAdapter = getMilvusAdapter(embeddingAdapter);

          try {
            await milvusAdapter.close();
            resetMilvusAdapter();
          } catch (error) {
            // Ignore
          }

          for (const entry of entries) {
            try {
              const textToEmbed = `${entry.title}\n${entry.content}`;
              const { embedding } = await embeddingAdapter.embed(textToEmbed);

              await milvusAdapter.insert({
                id: entry.id,
                embedding,
                metadata: {
                  title: entry.title,
                  content: entry.content,
                  type: entry.type,
                  tags: entry.tags.join(','),
                  timestamp: entry.timestamp,
                  scope,
                  projectPath: input.project_path,
                },
              });
              indexedCount++;
            } catch (error) {
              console.error('[Memory] Failed to index entry:', entry.id, error);
            }
          }

          return { ok: true, action: 'reindex', indexed_count: indexedCount, entries };
        }

        default:
          return { ok: false, action: input.action, error: `Unknown action` };
      }
    } catch (err) {
      return { ok: false, action: input.action, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
