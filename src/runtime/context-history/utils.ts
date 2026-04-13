/**
 * Context History Management - 共享工具函数
 */

import type { TaskDigest, SessionMessage, ConversationRound } from './types.js';

const TOKEN_RATIO = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_RATIO);
}

export function sortByTime<T extends { timestamp: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.timestamp - b.timestamp);
}

export function sortByTimeDesc<T extends { timestamp: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.timestamp - a.timestamp);
}

export function slidingWindowBudget<T extends { tokenCount: number; timestamp: number }>(
  items: T[],
  maxTokens: number,
): T[] {
  const sorted = sortByTimeDesc(items);
  const result: T[] = [];
  let totalTokens = 0;

  for (const item of sorted) {
    if (totalTokens + item.tokenCount <= maxTokens) {
      result.push(item);
      totalTokens += item.tokenCount;
    } else {
      break;
    }
  }

  return result.sort((a, b) => a.timestamp - b.timestamp);
}

export function mergeDigests(existing: TaskDigest[], newDigests: TaskDigest[]): TaskDigest[] {
  const all = [...existing, ...newDigests];
  return sortByTime(all);
}

export function groupMessagesByRound(messages: SessionMessage[]): ConversationRound[] {
  const rounds: ConversationRound[] = [];
  let currentRound: ConversationRound | null = null;
  let roundIndex = 0;

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (currentRound) {
        rounds.push(currentRound);
      }
      currentRound = {
        userMessage: msg,
        assistantMessages: [],
        toolCalls: [],
        roundIndex,
      };
      roundIndex++;
    } else if (currentRound) {
      if (msg.role === 'assistant') {
        currentRound.assistantMessages.push(msg);
      } else if (msg.role === 'system' && msg.metadata?.toolName) {
        currentRound.toolCalls.push(msg);
      }
    }
  }

  if (currentRound) {
    rounds.push(currentRound);
  }

  return rounds;
}

export function extractTagsFromMessages(messages: SessionMessage[]): string[] {
  const tags: Set<string> = new Set();

  for (const msg of messages) {
    if (msg.metadata?.toolName && typeof msg.metadata.toolName === 'string') {
      tags.add(msg.metadata.toolName);
    }

    const content = msg.content || '';
    const filePathPatterns = [
      /(?:\/[\w\-\.]+\/[\w\-\.]+\.\w+)/g,
      /(?:\.\w+\.\w+)/g,
    ];

    for (const pattern of filePathPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        matches.forEach((m) => tags.add(m));
      }
    }

    if (msg.metadata?.command && typeof msg.metadata.command === 'string') {
      const cmd = msg.metadata.command;
      const firstWord = cmd.split(' ')[0];
      if (firstWord.length > 0 && firstWord.length < 20) {
        tags.add(firstWord);
      }
    }
  }

  return Array.from(tags).slice(0, 8);
}

export function validateTokenBudget(
  history: TaskDigest[],
  maxTokens: number,
): { ok: boolean; actualTokens: number; overflow: number } {
  const actualTokens = history.reduce((sum, d) => sum + d.tokenCount, 0);
  const overflow = actualTokens - maxTokens;
  return {
    ok: overflow <= 0,
    actualTokens,
    overflow: overflow > 0 ? overflow : 0,
  };
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
