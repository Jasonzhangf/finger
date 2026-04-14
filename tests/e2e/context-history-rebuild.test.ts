/**
 * Context History Rebuild E2E 测试
 * 
 * 测试目标：
 * 1. 话题 Rebuild：搜索 digest → 相关性筛选 → 预算框选 → 时间排序
 * 2. 超限 Rebuild：直接读 ledger → 时间排序 → 预算框选
 * 
 * 验证内容：
 * - Session.messages 结构
 * - digest 数量
 * - 最近 3 轮是否完整保留
 * - token 预算是否在 20K 内
 * - 时间排序是否正确
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  rebuildByTopic,
  rebuildByOverflow,
  makeRebuildDecision,
  DEFAULT_CONFIG,
  type TaskDigest,
  type RebuildResult,
} from '../../src/runtime/context-history/index.js';
import type { SessionMessage } from '../../src/orchestration/session-types.js';

const TEST_SESSION_DIR = '/tmp/test-context-history-session';
const TEST_LEDGER_PATH = path.join(TEST_SESSION_DIR, 'context-ledger.jsonl');

describe('Context History Rebuild E2E', () => {
  beforeAll(() => {
    // 创建测试目录
    if (!fs.existsSync(TEST_SESSION_DIR)) {
      fs.mkdirSync(TEST_SESSION_DIR, { recursive: true });
    }
    
    // 创建模拟 ledger（包含多个 digest）
    const ledgerEntries: any[] = [];
    
    // 添加 10 个 context_compact 事件（模拟历史 digest）
    for (let i = 0; i < 10; i++) {
      const digest: TaskDigest = {
        request: `用户请求 ${i}`,
        summary: `执行结果摘要 ${i}`,
        key_tools: ['exec_command', 'apply_patch'],
        key_reads: [`file${i}.ts`],
        key_writes: [`file${i}_modified.ts`],
        tags: ['finger-302', 'context-history', `topic-${i}`],
        topic: `话题 ${i}: finger-302 上下文压缩模块`,
        tokenCount: 1000 + i * 100,
        timestamp: new Date(Date.now() - (10 - i) * 60000).toISOString(), // 每 1 分钟一个
      };
      
      ledgerEntries.push({
        event_type: 'context_compact',
        timestamp_ms: Date.now() - (10 - i) * 60000,
        timestamp_iso: digest.timestamp,
        payload: {
          replacement_history: [digest],
        },
      });
    }
    
    // 添加最近 5 轮对话
    for (let i = 0; i < 5; i++) {
      ledgerEntries.push({
        event_type: 'session_message',
        timestamp_ms: Date.now() - i * 10000,
        timestamp_iso: new Date(Date.now() - i * 10000).toISOString(),
        payload: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `最新消息 ${i}: 这是一个测试消息，包含一些内容。`,
        },
      });
    }
    
    // 写入 ledger
    fs.writeFileSync(TEST_LEDGER_PATH, ledgerEntries.map(e => JSON.stringify(e)).join('\n'));
  });
  
  afterAll(() => {
    // 清理测试目录
    if (fs.existsSync(TEST_SESSION_DIR)) {
      fs.rmSync(TEST_SESSION_DIR, { recursive: true });
    }
  });
  
  describe('话题 Rebuild', () => {
    it('应该搜索 digest 并按相关性筛选', async () => {
      const result = await rebuildByTopic(
        'test-session-topic',
        TEST_LEDGER_PATH,
        'finger-302 上下文压缩',
        {
          keywords: ['finger-302', '上下文', '压缩'],
          topK: 20,
          relevanceThreshold: 0.3,
          budgetTokens: DEFAULT_CONFIG.budgetTokens,
          timeoutMs: 2000,
        }
      );
      
      console.log('[话题 Rebuild 结果]', JSON.stringify(result, null, 2));
      
      // 验证结果
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('topic');
      expect(result.digestCount).toBeGreaterThan(0);
      expect(result.digestCount).toBeLessThan(10); // top 30% = 3 个
      
      // 验证 messages 结构
      expect(result.messages.length).toBeGreaterThan(0);
      
      // 验证 digest 标记
      const digestMessages = result.messages.filter(m => m.metadata?.compactDigest === true);
      expect(digestMessages.length).toBe(result.digestCount);
      
      // 验证最近 3 轮完整保留
      const recentMessages = result.messages.filter(m => !m.metadata?.compactDigest);
      expect(recentMessages.length).toBeLessThanOrEqual(6) // 最多 3 轮 = 6 条消息;
      
      // 验证 token 预算
      expect(result.totalTokens).toBeLessThan(DEFAULT_CONFIG.budgetTokens + 5000);
      
      // 验证时间排序
      const timestamps = digestMessages.map(m => m.timestamp);
      const sortedTimestamps = [...timestamps].sort();
      expect(timestamps).toEqual(sortedTimestamps);
    });
    
    it('应该验证 digest 内容结构', async () => {
      const result = await rebuildByTopic(
        'test-session-topic-content',
        TEST_LEDGER_PATH,
        'finger-302',
        {
          keywords: ['finger-302'],
          topK: 20,
          relevanceThreshold: 0.3,
          budgetTokens: DEFAULT_CONFIG.budgetTokens,
          timeoutMs: 2000,
        }
      );
      
      console.log('[Digest 内容结构]', JSON.stringify(result.messages.filter(m => m.metadata?.compactDigest), null, 2));
      
      // 验证每个 digest 的内容结构
      const digestMessages = result.messages.filter(m => m.metadata?.compactDigest);
      
      for (const msg of digestMessages) {
        // 验证 content 是 digest 格式
        expect(msg.content.toLowerCase()).toContain('request');
        expect(msg.content.toLowerCase()).toContain('summary');
        expect(msg.content.toLowerCase()).toContain('key tools');
        
        // 验证 metadata
        expect(msg.metadata?.compactDigest).toBe(true);
        expect(msg.metadata?.ledgerLine).toBeDefined();
      }
    });
  });
  
  describe('超限 Rebuild', () => {
    it('应该直接读 ledger digest 并预算框选', async () => {
      const result = await rebuildByOverflow(
        'test-session-overflow',
        TEST_LEDGER_PATH,
        DEFAULT_CONFIG.budgetTokens
      );
      
      console.log('[超限 Rebuild 结果]', JSON.stringify(result, null, 2));
      
      // 验证结果
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('overflow');
      expect(result.digestCount).toBeGreaterThan(0);
      
      // 验证 messages 结构
      expect(result.messages.length).toBeGreaterThan(0);
      
      // 验证 digest 标记
      const digestMessages = result.messages.filter(m => m.metadata?.compactDigest === true);
      expect(digestMessages.length).toBe(result.digestCount);
      
      // 验证最近 3 轮完整保留
      const recentMessages = result.messages.filter(m => !m.metadata?.compactDigest);
      expect(recentMessages.length).toBeLessThanOrEqual(6) // 最多 3 轮 = 6 条消息;
      
      // 验证 token 预算
      expect(result.totalTokens).toBeLessThan(DEFAULT_CONFIG.budgetTokens + 5000);
      
      // 验证时间排序
      const timestamps = digestMessages.map(m => m.timestamp);
      const sortedTimestamps = [...timestamps].sort();
      expect(timestamps).toEqual(sortedTimestamps);
    });
    
    it('应该验证预算框选正确性', async () => {
      // 使用较小预算测试
      const smallBudget = 5000;
      const result = await rebuildByOverflow(
        'test-session-overflow-small',
        TEST_LEDGER_PATH,
        smallBudget
      );
      
      console.log('[小预算超限 Rebuild 结果]', JSON.stringify(result, null, 2));
      
      // 验证 token 预算
      expect(result.totalTokens).toBeLessThan(smallBudget + 3000);
      
      // 验证 digest 数量减少（因为预算更小）
      const normalResult = await rebuildByOverflow(
        'test-session-overflow-normal',
        TEST_LEDGER_PATH,
        DEFAULT_CONFIG.budgetTokens
      );
      
      expect(result.digestCount).toBeLessThanOrEqual(normalResult.digestCount);
    });
  });
  
  describe('触发判断', () => {
    it('应该正确判断新 session', () => {
      const decision = makeRebuildDecision(
        'test-new-session',
        [], // 空 messages
        '测试输入',
        undefined,
        undefined
      );
      
      console.log('[新 session 判断]', JSON.stringify(decision, null, 2));
      
      expect(decision.shouldRebuild).toBe(true);
      expect(decision.trigger).toBe('new_session');
      expect(decision.mode).toBe('topic');
    });
    
    it('应该正确判断心跳 session', () => {
      const messages: SessionMessage[] = [
        { id: '1', role: 'user', content: 'test', timestamp: new Date().toISOString() },
      ];
      
      const decision = makeRebuildDecision(
        'hb-session-test',
        messages,
        '心跳任务',
        undefined,
        undefined
      );
      
      console.log('[心跳 session 判断]', JSON.stringify(decision, null, 2));
      
      expect(decision.shouldRebuild).toBe(true);
      expect(decision.trigger).toBe('heartbeat');
      expect(decision.mode).toBe('topic');
    });
    
    it('应该正确判断上下文超限', () => {
      // 模拟超限 messages
      const largeMessages: SessionMessage[] = [];
      for (let i = 0; i < 500; i++) {
        largeMessages.push({
          id: `msg-${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: '这是一个超长的消息内容，模拟上下文超限场景。' + 'x'.repeat(500),
          timestamp: new Date().toISOString(),
        });
      }
      
      const decision = makeRebuildDecision(
        'test-overflow-session',
        largeMessages,
        '测试输入',
        undefined,
        undefined
      );
      
      console.log('[超限判断]', JSON.stringify(decision, null, 2));
      
      expect(decision.shouldRebuild).toBe(true);
      expect(decision.trigger).toBe('overflow');
      expect(decision.mode).toBe('overflow');
    });
    
    it('应该正确判断换话题（多轮命中）', () => {
      const messages: SessionMessage[] = [
        { id: '1', role: 'user', content: 'test', timestamp: new Date().toISOString() },
      ];
      
      // 第一次命中
      const decision1 = makeRebuildDecision(
        'test-topic-shift',
        messages,
        '新话题',
        '新话题内容',
        0.8 // 高置信度
      );
      
      console.log('[换话题第一次命中]', JSON.stringify(decision1, null, 2));
      
      // 第一次命中不触发（需要连续 N 次）
      expect(decision1.shouldRebuild).toBe(false);
      
      // 第二次命中（话题不同）
      const decision2 = makeRebuildDecision(
        'test-topic-shift',
        messages,
        '另一个话题',
        '另一个话题内容',
        0.85
      );
      
      console.log('[换话题第二次命中]', JSON.stringify(decision2, null, 2));
      
      // 第二次命中应该触发
      expect(decision2.shouldRebuild).toBe(true);
      expect(decision2.trigger).toBe('topic_shift');
      expect(decision2.mode).toBe('topic');
      expect(decision2.searchKeywords).toBeDefined();
    });
  });
});
