/**
 * Backfill Digests V2 - 从旧 Ledger 提取 Digest
 * 
 * 用途：检查 compact-memory.jsonl 是否包含 digest_block
 * 如果没有，从 context-ledger.jsonl 提取并生成 digest_block
 */

import { readJsonLines, appendLedgerEvent, resolveLedgerPath, resolveCompactMemoryPath } from '../src/runtime/context-ledger-memory-helpers.js';
import type { LedgerEntryFile, CompactMemoryEntryFile } from '../src/runtime/context-ledger-memory-types.js';
import { estimateTokens } from '../src/utils/token-counter.js';
import * as path from 'path';
import * as fs from 'fs/promises';

const TRUNCATE_LENGTH = 500;
const MAX_DIGEST_TOKENS = 150;

function truncateContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.substring(0, maxLen) + '...';
}

function toDigestMessage(entry: LedgerEntryFile): CompactMemoryEntryFile | null {
  if (entry.event_type === 'context_compact' || entry.event_type === 'digest_block') {
    return null; // Skip existing compacts
  }
  
  const payload = entry.payload as Record<string, unknown>;
  let content = '';
  let role: 'user' | 'assistant' | 'system' = 'user';
  
  // Extract content from payload
  if (typeof payload.content === 'string') {
    content = payload.content;
  } else if (typeof payload.text === 'string') {
    content = payload.text;
  } else if (typeof payload.message === 'string') {
    content = payload.message;
  } else if (typeof payload.summary === 'string') {
    content = payload.summary;
  }
  
  // Determine role
  if (entry.event_type.includes('user') || entry.event_type === 'user_message') {
    role = 'user';
  } else if (entry.event_type.includes('assistant') || entry.event_type.includes('tool')) {
    role = 'assistant';
  } else if (entry.event_type.includes('system')) {
    role = 'system';
  }
  
  if (!content || content.length < 10) return null;
  
  const truncated = truncateContent(content, TRUNCATE_LENGTH);
  const tokenCount = Math.min(estimateTokens(truncated), MAX_DIGEST_TOKENS);
  
  return {
    id: `digest-${entry.timestamp_ms}-${Math.floor(Math.random() * 1000000)}`,
    timestamp_ms: entry.timestamp_ms,
    timestamp_iso: entry.timestamp_iso,
    session_id: entry.session_id,
    agent_id: entry.agent_id,
    mode: entry.mode,
    event_type: 'digest_block',
    payload: {
      messages: [{
        id: entry.id,
        role,
        content: truncated,
        timestamp: entry.timestamp_iso,
        token_count: tokenCount,
      }],
      tags: [],
      total_tokens: tokenCount,
      turn_digest: true,
    },
  };
}

async function processSession(sessionDir: string): Promise<{ sessionDir: string; created: number; skipped: number }> {
  const parts = sessionDir.split(path.sep);
  const agentId = parts[parts.length - 2] || 'unknown';
  const mode = parts[parts.length - 1] || 'main';
  const sessionId = parts[parts.length - 3] || 'unknown';
  
  const ledgerPath = path.join(sessionDir, 'context-ledger.jsonl');
  const compactPath = path.join(sessionDir, 'compact-memory.jsonl');
  
  try {
    await fs.access(ledgerPath);
  } catch {
    return { sessionDir, created: 0, skipped: 0 };
  }
  
  // Check if compact-memory already has digest_block
  let existingDigests: Set<string> = new Set();
  try {
    const compactEntries = await readJsonLines<CompactMemoryEntryFile>(compactPath);
    for (const entry of compactEntries) {
      if (entry.event_type === 'digest_block') {
        existingDigests.add(entry.timestamp_ms.toString());
      }
    }
  } catch {
    // No compact-memory yet
  }
  
  // Read ledger entries
  const ledgerEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);
  
  // Extract digests for entries not already digested
  const digests: CompactMemoryEntryFile[] = [];
  for (const entry of ledgerEntries) {
    if (existingDigests.has(entry.timestamp_ms.toString())) continue;
    
    const digest = toDigestMessage(entry);
    if (digest) {
      digests.push(digest);
    }
  }
  
  // Append digests
  for (const digest of digests) {
    await appendLedgerEvent(compactPath, {
      session_id: digest.session_id,
      agent_id: digest.agent_id,
      mode: digest.mode,
      event_type: digest.event_type,
      payload: digest.payload,
    });
  }
  
  return { sessionDir, created: digests.length, skipped: ledgerEntries.length - digests.length };
}

async function main() {
  const sessionsRoot = path.join(process.env.HOME || '', '.finger', 'sessions');
  const systemSessionsRoot = path.join(process.env.HOME || '', '.finger', 'system', 'sessions');
  
  const roots = [sessionsRoot, systemSessionsRoot];
  let totalCreated = 0;
  let totalSkipped = 0;
  
  for (const root of roots) {
    const sessionDirs = await findSessionDirs(root);
    console.log(`[Backfill] Processing ${sessionDirs.length} sessions from ${root}`);
    
    for (const sessionDir of sessionDirs) {
      const result = await processSession(sessionDir);
      if (result.created > 0) {
        console.log(`[Backfill] ${sessionDir}: created ${result.created} digests`);
      }
      totalCreated += result.created;
      totalSkipped += result.skipped;
    }
  }
  
  console.log(`[Backfill] Total: created ${totalCreated} digests, skipped ${totalSkipped} entries`);
}

async function findSessionDirs(root: string): Promise<string[]> {
  const dirs: string[] = [];
  const projects = await fs.readdir(root).catch(() => []);
  
  for (const project of projects) {
    const projectPath = path.join(root, project);
    const stat = await fs.stat(projectPath).catch(() => null);
    if (!stat?.isDirectory()) continue;
    
    const sessions = await fs.readdir(projectPath).catch(() => []);
    for (const session of sessions) {
      const sessionPath = path.join(projectPath, session);
      const agents = await fs.readdir(sessionPath).catch(() => []);
      
      for (const agent of agents) {
        const agentPath = path.join(sessionPath, agent);
        const modes = await fs.readdir(agentPath).catch(() => []);
        
        for (const mode of modes) {
          const modePath = path.join(agentPath, mode);
          const ledgerPath = path.join(modePath, 'context-ledger.jsonl');
          try {
            await fs.access(ledgerPath);
            dirs.push(modePath);
          } catch {
            // No ledger
          }
        }
      }
    }
  }
  
  return dirs;
}

main().catch(console.error);
