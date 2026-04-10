/**
 * Session Search Tool - Cross-session search via mempalace
 *
 * Provides cross-session memory search capability using the mempalace
 * semantic search index. Complements context_ledger.memory (session-scoped)
 * with the ability to search across all sessions and project memory.
 */

import type { InternalTool, ToolExecutionContext } from './types.js';
import { logger } from '../../core/logger.js';
import { searchMempalace, healthMempalace, isMempalaceAvailable } from './memory/mempalace-bridge.js';

export interface SessionSearchInput {
  action: 'search' | 'list_recent' | 'health';
  query?: string;
  limit?: number;
  wing?: string;
  room?: string;
}

export interface SessionSearchResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
  source_file?: string;
  drawer?: string;
}

export interface SessionSearchOutput {
  ok: boolean;
  action: string;
  results?: SessionSearchResult[];
  health?: {
    healthy: boolean;
    daemon_running?: boolean;
    indexed_drawers?: number;
  };
  error?: string;
  total?: number;
}

const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_ROOM = 'memory';

export const sessionSearchTool: InternalTool<unknown, SessionSearchOutput> = {
  name: 'session_search',
  executionModel: 'state',
  description: 'Cross-session search via mempalace semantic index. Actions: search (query across sessions), list_recent (recent indexed entries), health (check mempalace status). Complements context_ledger.memory with cross-session capability.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'list_recent', 'health'],
        description: 'Action to perform',
      },
      query: {
        type: 'string',
        description: 'Search query for semantic search',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10)',
      },
      wing: {
        type: 'string',
        description: 'Mempalace wing to search within',
      },
      room: {
        type: 'string',
        description: 'Mempalace room to search within (default: memory)',
      },
    },
    required: ['action'],
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<SessionSearchOutput> => {
    const input = rawInput as SessionSearchInput;
    const action = input.action || 'search';

    try {
      // Check mempalace availability
      if (!isMempalaceAvailable()) {
        return {
          ok: false,
          action,
          error: 'mempalace CLI is not available at /opt/homebrew/bin/mempalace',
        };
      }

      switch (action) {
        case 'search': {
          const query = input.query;
          if (!query || query.trim().length === 0) {
            return {
              ok: false,
              action: 'search',
              error: 'query is required for search action',
            };
          }

          const limit = input.limit || DEFAULT_SEARCH_LIMIT;
          const room = input.room || DEFAULT_ROOM;

          logger.module('session-search').debug('Executing cross-session search', {
            query,
            limit,
            room,
            wing: input.wing,
            sessionId: context.sessionId,
          });

          const results = await searchMempalace(query, {
            wing: input.wing,
            room,
            limit,
          });

          const searchResults: SessionSearchResult[] = results.map((r) => ({
            id: r.id,
            content: r.content,
            score: r.score,
            metadata: r.metadata,
            source_file: r.source_file,
            drawer: r.drawer,
          }));

          logger.module('session-search').debug('Cross-session search completed', {
            query,
            resultCount: searchResults.length,
          });

          return {
            ok: true,
            action: 'search',
            results: searchResults,
            total: searchResults.length,
          };
        }

        case 'list_recent': {
          // List recent entries by searching with a broad query
          const limit = input.limit || DEFAULT_SEARCH_LIMIT;
          const room = input.room || DEFAULT_ROOM;

          logger.module('session-search').debug('Listing recent memory entries', {
            limit,
            room,
          });

          // Use a broad query to get recent entries
          const results = await searchMempalace('*', {
            wing: input.wing,
            room,
            limit,
          });

          const recentResults: SessionSearchResult[] = results.map((r) => ({
            id: r.id,
            content: r.content,
            score: r.score,
            metadata: r.metadata,
            source_file: r.source_file,
            drawer: r.drawer,
          }));

          return {
            ok: true,
            action: 'list_recent',
            results: recentResults,
            total: recentResults.length,
          };
        }

        case 'health': {
          const healthResult = await healthMempalace();

          return {
            ok: true,
            action: 'health',
            health: {
              healthy: healthResult.healthy,
              daemon_running: healthResult.daemon_running,
              indexed_drawers: healthResult.indexed_drawers,
            },
          };
        }

        default:
          return {
            ok: false,
            action,
            error: `Unknown action: ${action}`,
          };
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.module('session-search').error('Session search tool error', err, { action });

      return {
        ok: false,
        action,
        error: err.message,
      };
    }
  },
};