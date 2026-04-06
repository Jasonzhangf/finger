#!/usr/bin/env pnpm exec tsx
/**
 * 补齐旧的 digest（为所有 finish_reason=stop 的消息生成 digest_block）
 * 
 * 使用方法：
 *   pnpm exec tsx scripts/backfill-digests.ts [--session <session-id>] [--dry-run]
 */

import * as fs from 'fs';
import * as path from 'path';
import { FINGER_HOME } from '../src/core/finger-paths.js';

interface SessionMessage {
  id: string;
  event_type: string;
  session_id: string;
  agent_id: string;
  mode: string;
  timestamp_ms: number;
  timestamp_iso: string;
  payload: {
    role: 'user' | 'assistant' | 'system';
    content: string;
    metadata?: Record<string, unknown>;
  };
}

interface DigestBlock {
  id: string;
  timestamp_ms: number;
  timestamp_iso: string;
  session_id: string;
  agent_id: string;
  mode: string;
  event_type: 'digest_block';
  payload: {
    messages: Array<{
      id: string;
      role: string;
      content: string;
      timestamp: string;
      token_count: number;
    }>;
    tags: string[];
    total_tokens: number;
    turn_digest: true;
  };
}

function estimateTokens(content: string): number {
  // 粗略估算：4 字符 = 1 token
  return Math.ceil(content.length / 4);
}

function extractTags(message: SessionMessage): string[] {
  // 从 metadata 中提取 tags
  const tags: string[] = [];
  
  if (message.payload.metadata?.tags) {
    const msgTags = message.payload.metadata.tags;
    if (Array.isArray(msgTags)) {
      tags.push(...msgTags.filter((t): t is string => typeof t === 'string'));
    }
  }
  
  return tags;
}

function toDigestMessage(message: SessionMessage): DigestBlock['payload']['messages'][0] {
  const content = message.payload.content || '';
  const truncated = content.slice(0, 500);
  
  return {
    id: message.id,
    role: message.payload.role,
    content: truncated,
    timestamp: message.timestamp_iso,
    token_count: estimateTokens(truncated),
  };
}

async function processSession(sessionDir: string, dryRun: boolean): Promise<{ session: string; digests: number; skipped: number }> {
  const sessionId = path.basename(sessionDir);
  const ledgerPath = path.join(sessionDir, 'finger-system-agent', 'main', 'context-ledger.jsonl');
  const compactPath = path.join(sessionDir, 'finger-system-agent', 'main', 'compact-memory.jsonl');
  
  if (!fs.existsSync(ledgerPath)) {
    return { session: sessionId, digests: 0, skipped: 0 };
  }
  
  // 读取 ledger
  const ledgerContent = fs.readFileSync(ledgerPath, 'utf-8');
  const lines = ledgerContent.trim().split('\n').filter(l => l.trim());
  
  // 读取已有的 compact-memory
  const existingDigests = new Set<string>();
  if (fs.existsSync(compactPath)) {
    const compactContent = fs.readFileSync(compactPath, 'utf-8');
    const compactLines = compactContent.trim().split('\n').filter(l => l.trim());
    for (const line of compactLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.event_type === 'digest_block' && entry.payload?.turn_digest) {
          existingDigests.add(entry.id);
        }
      } catch {}
    }
  }
  
  // 找到所有 finish_reason=stop 的 assistant 消息
  const digestBlocks: DigestBlock[] = [];
  let skipped = 0;
  
  for (const line of lines) {
    try {
      const message: SessionMessage = JSON.parse(line);
      
      // 只处理 assistant 消息
      if (message.payload.role !== 'assistant') continue;
      
      // 检查是否已有 digest
      if (existingDigests.has(`digest-${message.timestamp_ms}`)) {
        skipped++;
        continue;
      }
      
      // 提取 tags
      const tags = extractTags(message);
      
      // 生成 digest
      const digestMessage = toDigestMessage(message);
      
      const digestBlock: DigestBlock = {
        id: `digest-${message.timestamp_ms}-${Math.floor(Math.random() * 1_000_000)}`,
        timestamp_ms: message.timestamp_ms,
        timestamp_iso: message.timestamp_iso,
        session_id: message.session_id,
        agent_id: message.agent_id,
        mode: message.mode,
        event_type: 'digest_block',
        payload: {
          messages: [digestMessage],
          tags,
          total_tokens: digestMessage.token_count,
          turn_digest: true,
        },
      };
      
      digestBlocks.push(digestBlock);
    } catch {}
  }
  
  // 写入 digest
  if (digestBlocks.length > 0 && !dryRun) {
    const compactDir = path.dirname(compactPath);
    if (!fs.existsSync(compactDir)) {
      fs.mkdirSync(compactDir, { recursive: true });
    }
    
    const appendContent = digestBlocks.map(b => JSON.stringify(b)).join('\n') + '\n';
    fs.appendFileSync(compactPath, appendContent, 'utf-8');
  }
  
  return { session: sessionId, digests: digestBlocks.length, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const sessionArg = args.find(a => !a.startsWith('--'));
  
  const sessionsRoot = path.join(FINGER_HOME, 'system', 'sessions');
  
  console.log(`=== Backfill Digests ===`);
  console.log(`Sessions root: ${sessionsRoot}`);
  console.log(`Dry run: ${dryRun}`);
  console.log('');
  
  let sessionDirs: string[];
  
  if (sessionArg) {
    // 处理指定 session
    sessionDirs = [path.join(sessionsRoot, sessionArg)];
  } else {
    // 处理所有 session
    sessionDirs = fs.readdirSync(sessionsRoot)
      .filter(name => name.startsWith('session-') || name.startsWith('hb-session-'))
      .map(name => path.join(sessionsRoot, name));
  }
  
  console.log(`Found ${sessionDirs.length} sessions to process`);
  console.log('');
  
  let totalDigests = 0;
  let totalSkipped = 0;
  
  for (const sessionDir of sessionDirs) {
    const result = await processSession(sessionDir, dryRun);
    if (result.digests > 0 || result.skipped > 0) {
      console.log(`${result.session}: ${result.digests} digests created, ${result.skipped} skipped`);
      totalDigests += result.digests;
      totalSkipped += result.skipped;
    }
  }
  
  console.log('');
  console.log(`=== Summary ===`);
  console.log(`Total digests created: ${totalDigests}`);
  console.log(`Total skipped: ${totalSkipped}`);
  console.log(`Dry run: ${dryRun}`);
}

main().catch(console.error);
