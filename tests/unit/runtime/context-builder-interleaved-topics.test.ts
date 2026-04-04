import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildContext } from '../../../src/runtime/context-builder.js';
import * as kernelProviderClient from '../../../src/core/kernel-provider-client.js';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function buildInterleavedMessages(baseMs: number) {
  const deepseekTaskStart = baseMs;
  const qwenTaskStart = baseMs + 60_000;
  const deepseekFollowupStart = baseMs + 120_000;

  const step3Messages = [
    {
      id: 'u-deepseek-summary',
      role: 'user',
      content: '请上网搜索并总结 DeepSeek 过去一年的进展',
      timestamp: iso(deepseekTaskStart),
    },
    {
      id: 'a-deepseek-plan',
      role: 'assistant',
      content: '先制定计划，再执行两轮工具查询（官方发布 + 社区汇总）。',
      timestamp: iso(deepseekTaskStart + 10_000),
    },
    {
      id: 'a-deepseek-toolcall',
      role: 'assistant',
      content: '[toolcall] web.search {\"q\":\"DeepSeek 过去一年 模型发布\"}',
      timestamp: iso(deepseekTaskStart + 12_000),
      metadata: { toolName: 'web.search', toolStatus: 'success', tags: ['deepseek', 'research'], topic: 'deepseek' },
    },
    {
      id: 'a-deepseek-summary',
      role: 'assistant',
      content: '[tool_result] 命中 12 条来源；已完成：DeepSeek 过去一年里发布了多轮模型与工具链更新。',
      timestamp: iso(deepseekTaskStart + 20_000),
      metadata: { tags: ['deepseek', 'research'], topic: 'deepseek' },
    },
    {
      id: 'u-qwen-summary',
      role: 'user',
      content: '请上网搜索并总结阿里千问过去一年的进展',
      timestamp: iso(qwenTaskStart),
    },
    {
      id: 'a-qwen-plan',
      role: 'assistant',
      content: '按同样流程执行两轮工具查询（官网公告 + 生态更新）。',
      timestamp: iso(qwenTaskStart + 10_000),
    },
    {
      id: 'a-qwen-toolcall',
      role: 'assistant',
      content: '[toolcall] web.search {\"q\":\"阿里千问 过去一年 模型发布\"}',
      timestamp: iso(qwenTaskStart + 12_000),
      metadata: { toolName: 'web.search', toolStatus: 'success', tags: ['qwen', 'research'], topic: 'qwen' },
    },
    {
      id: 'a-qwen-summary',
      role: 'assistant',
      content: '[tool_result] 命中 15 条来源；已完成：阿里千问过去一年推出多条 Qwen 系列模型线。',
      timestamp: iso(qwenTaskStart + 20_000),
      metadata: { tags: ['qwen', 'research'], topic: 'qwen' },
    },
    {
      id: 'u-deepseek-followup',
      role: 'user',
      content: '回到话题一：DeepSeek 上一次模型发布是什么，时间点是什么？',
      timestamp: iso(deepseekFollowupStart),
    },
  ] as const;

  const step4Messages = [
    ...step3Messages,
    {
      id: 'a-deepseek-followup-toolcall',
      role: 'assistant',
      content: '[toolcall] web.search {\"q\":\"DeepSeek 最新一次模型发布时间\"}',
      timestamp: iso(deepseekFollowupStart + 10_000),
      metadata: { toolName: 'web.search', toolStatus: 'success', tags: ['deepseek', 'release'], topic: 'deepseek' },
    },
    {
      id: 'a-deepseek-followup',
      role: 'assistant',
      content: '[tool_result] 上一轮 DeepSeek 发布为 DeepSeek-V3.2，发布时间示例为 2026-02-10。',
      timestamp: iso(deepseekFollowupStart + 20_000),
      metadata: { tags: ['deepseek', 'release'], topic: 'deepseek' },
    },
    {
      id: 'u-qwen-followup',
      role: 'user',
      content: '回到话题二：阿里千问的最新模型是什么？',
      timestamp: iso(baseMs + 180_000),
    },
  ] as const;

  return {
    step3Messages,
    step4Messages,
    deepseekBlockId: `task-${deepseekTaskStart}`,
    qwenBlockId: `task-${qwenTaskStart}`,
  };
}

function getHistoricalBlockIds(meta: Record<string, unknown>): string[] {
  const raw = meta.historicalBlockIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === 'string');
}

function isChronological(starts: number[]): boolean {
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i] < starts[i - 1]) return false;
  }
  return true;
}

function setupLedgerRoot(tag: string): { rootDir: string; sessionId: string; agentId: string; mode: string } {
  const rootDir = join(tmpdir(), `finger-ctx-builder-interleaved-${tag}-${Date.now()}`);
  return {
    rootDir,
    sessionId: 'ctx-interleaved-ledger',
    agentId: 'finger-system-agent',
    mode: 'main',
  };
}

function writeLedger(params: {
  rootDir: string;
  sessionId: string;
  agentId: string;
  mode: string;
  messages: ReadonlyArray<{
    id: string;
    role: string;
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }>;
}): void {
  const { rootDir, sessionId, agentId, mode, messages } = params;
  const dir = join(rootDir, sessionId, agentId, mode);
  mkdirSync(dir, { recursive: true });
  const ledgerPath = join(dir, 'context-ledger.jsonl');
  const lines = messages.map((message) => {
    const timestampMs = Date.parse(message.timestamp);
    return JSON.stringify({
      id: message.id,
      timestamp_ms: timestampMs,
      timestamp_iso: message.timestamp,
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'session_message',
      payload: {
        role: message.role,
        content: message.content,
        token_count: 10,
        ...(message.metadata ? { metadata: message.metadata } : {}),
      },
    });
  });
  writeFileSync(ledgerPath, `${lines.join('\n')}\n`, 'utf-8');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('context rebuild: interleaved topics', () => {
  it('selects correct topic history across interleaved deepseek/qwen follow-up questions', async () => {
    const baseMs = Date.UTC(2026, 0, 15, 2, 0, 0);
    const data = buildInterleavedMessages(baseMs);

    vi.spyOn(kernelProviderClient, 'resolveKernelProvider').mockImplementation(() => ({
      provider: {
        id: 'ranker',
        base_url: 'https://ranker.example',
        wire_api: 'responses',
        env_key: 'RANKER_TEST_KEY',
        model: 'ranker-model',
      },
    }));

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ output_text: '{"selectedTags":["deepseek"],"selectedTaskIds":[]}' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ output_text: '{"selectedTags":["qwen"],"selectedTaskIds":[]}' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    vi.stubGlobal('fetch', fetchSpy);

    const step3 = await buildContext(
      {
        rootDir: '/tmp/finger-context-rebuild-tests',
        sessionId: 'ctx-interleaved-s1',
        agentId: 'finger-system-agent',
        mode: 'main',
        currentPrompt: 'DeepSeek 上一次模型发布是什么，时间点是什么？',
        sessionMessages: data.step3Messages,
      },
      {
        targetBudget: 1_000_000,
        includeMemoryMd: false,
        enableTaskGrouping: true,
        enableModelRanking: true,
        rankingProviderId: 'ranker',
        rebuildTrigger: 'bootstrap_first',
        buildMode: 'aggressive',
        preferCompactHistory: false,
      },
    );

    expect(step3.ok).toBe(true);
    expect(step3.metadata.selectedTags).toEqual(['deepseek']);
    const step3Text = step3.messages.map((m) => m.content).join('\n');
    expect(step3Text).toContain('DeepSeek 过去一年的进展');
    expect(step3Text).toContain('web.search {"q":"DeepSeek 过去一年 模型发布"}');
    expect(step3Text).not.toContain('阿里千问过去一年的进展');
    expect(step3Text).not.toContain('web.search {"q":"阿里千问 过去一年 模型发布"}');

    const step3HistoricalIds = getHistoricalBlockIds(step3.metadata);
    expect(step3HistoricalIds).toContain(data.deepseekBlockId);
    expect(step3HistoricalIds).not.toContain(data.qwenBlockId);
    expect(isChronological(step3.rankedTaskBlocks.map((b) => b.startTime))).toBe(true);

    const step4 = await buildContext(
      {
        rootDir: '/tmp/finger-context-rebuild-tests',
        sessionId: 'ctx-interleaved-s1',
        agentId: 'finger-system-agent',
        mode: 'main',
        currentPrompt: '阿里千问的最新模型是什么？',
        sessionMessages: data.step4Messages,
      },
      {
        targetBudget: 1_000_000,
        includeMemoryMd: false,
        enableTaskGrouping: true,
        enableModelRanking: true,
        rankingProviderId: 'ranker',
        rebuildTrigger: 'bootstrap_first',
        buildMode: 'aggressive',
        preferCompactHistory: false,
      },
    );

    expect(step4.ok).toBe(true);
    expect(step4.metadata.selectedTags).toEqual(['qwen']);
    const step4Text = step4.messages.map((m) => m.content).join('\n');
    expect(step4Text).toContain('阿里千问过去一年的进展');
    expect(step4Text).toContain('web.search {"q":"阿里千问 过去一年 模型发布"}');
    expect(step4Text).not.toContain('DeepSeek 过去一年的进展');
    expect(step4Text).not.toContain('web.search {"q":"DeepSeek 过去一年 模型发布"}');

    const step4HistoricalIds = getHistoricalBlockIds(step4.metadata);
    expect(step4HistoricalIds).toContain(data.qwenBlockId);
    expect(step4HistoricalIds).not.toContain(data.deepseekBlockId);
    expect(isChronological(step4.rankedTaskBlocks.map((b) => b.startTime))).toBe(true);
  });

  it('keeps final historical order chronological even when ranking result order is reversed', async () => {
    const baseMs = Date.UTC(2026, 0, 15, 2, 0, 0);
    const data = buildInterleavedMessages(baseMs);

    vi.spyOn(kernelProviderClient, 'resolveKernelProvider').mockImplementation(() => ({
      provider: {
        id: 'ranker',
        base_url: 'https://ranker.example',
        wire_api: 'responses',
        env_key: 'RANKER_TEST_KEY',
        model: 'ranker-model',
      },
    }));

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({
        output_text: JSON.stringify({
          rankedTaskIds: [data.qwenBlockId, data.deepseekBlockId],
        }),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    const result = await buildContext(
      {
        rootDir: '/tmp/finger-context-rebuild-tests',
        sessionId: 'ctx-interleaved-rank-order',
        agentId: 'finger-system-agent',
        mode: 'main',
        currentPrompt: '请对两个话题做回顾',
        sessionMessages: data.step3Messages,
      },
      {
        targetBudget: 1_000_000,
        includeMemoryMd: false,
        enableTaskGrouping: true,
        enableModelRanking: true,
        rankingProviderId: 'ranker',
        rebuildTrigger: 'manual',
        buildMode: 'aggressive',
        preferCompactHistory: false,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.metadata.rankingIds).toEqual([data.qwenBlockId, data.deepseekBlockId]);

    const historicalIds = getHistoricalBlockIds(result.metadata);
    expect(historicalIds).toEqual([data.deepseekBlockId, data.qwenBlockId]);
    expect(isChronological(result.rankedTaskBlocks.map((b) => b.startTime))).toBe(true);
  });

  it('rebuilds correctly from raw ledger replay (no sessionMessages)', async () => {
    const baseMs = Date.UTC(2026, 0, 15, 2, 0, 0);
    const data = buildInterleavedMessages(baseMs);
    const setup = setupLedgerRoot('ledger-replay');

    vi.spyOn(kernelProviderClient, 'resolveKernelProvider').mockImplementation(() => ({
      provider: {
        id: 'ranker',
        base_url: 'https://ranker.example',
        wire_api: 'responses',
        env_key: 'RANKER_TEST_KEY',
        model: 'ranker-model',
      },
    }));

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ output_text: '{"selectedTags":["deepseek"],"selectedTaskIds":[]}' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ output_text: '{"selectedTags":["qwen"],"selectedTaskIds":[]}' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    vi.stubGlobal('fetch', fetchSpy);

    try {
      writeLedger({
        rootDir: setup.rootDir,
        sessionId: setup.sessionId,
        agentId: setup.agentId,
        mode: setup.mode,
        messages: data.step3Messages,
      });

      const step3 = await buildContext(
        {
          rootDir: setup.rootDir,
          sessionId: setup.sessionId,
          agentId: setup.agentId,
          mode: setup.mode,
          currentPrompt: 'DeepSeek 上一次模型发布是什么，时间点是什么？',
        },
        {
          targetBudget: 1_000_000,
          includeMemoryMd: false,
          enableTaskGrouping: true,
          enableModelRanking: true,
          rankingProviderId: 'ranker',
          rebuildTrigger: 'bootstrap_first',
          buildMode: 'aggressive',
          preferCompactHistory: false,
        },
      );

      expect(step3.metadata.selectedTags).toEqual(['deepseek']);
      expect(getHistoricalBlockIds(step3.metadata)).toContain(data.deepseekBlockId);
      expect(getHistoricalBlockIds(step3.metadata)).not.toContain(data.qwenBlockId);
      const step3Text = step3.messages.map((m) => m.content).join('\n');
      expect(step3Text).toContain('DeepSeek 过去一年的进展');
      expect(step3Text).toContain('web.search {"q":"DeepSeek 过去一年 模型发布"}');
      expect(step3Text).not.toContain('阿里千问过去一年的进展');
      expect(step3Text).not.toContain('web.search {"q":"阿里千问 过去一年 模型发布"}');

      writeLedger({
        rootDir: setup.rootDir,
        sessionId: setup.sessionId,
        agentId: setup.agentId,
        mode: setup.mode,
        messages: data.step4Messages,
      });

      const step4 = await buildContext(
        {
          rootDir: setup.rootDir,
          sessionId: setup.sessionId,
          agentId: setup.agentId,
          mode: setup.mode,
          currentPrompt: '阿里千问的最新模型是什么？',
        },
        {
          targetBudget: 1_000_000,
          includeMemoryMd: false,
          enableTaskGrouping: true,
          enableModelRanking: true,
          rankingProviderId: 'ranker',
          rebuildTrigger: 'bootstrap_first',
          buildMode: 'aggressive',
          preferCompactHistory: false,
        },
      );

      expect(step4.metadata.selectedTags).toEqual(['qwen']);
      expect(getHistoricalBlockIds(step4.metadata)).toContain(data.qwenBlockId);
      expect(getHistoricalBlockIds(step4.metadata)).not.toContain(data.deepseekBlockId);
      const step4Text = step4.messages.map((m) => m.content).join('\n');
      expect(step4Text).toContain('阿里千问过去一年的进展');
      expect(step4Text).toContain('web.search {"q":"阿里千问 过去一年 模型发布"}');
      expect(step4Text).not.toContain('DeepSeek 过去一年的进展');
      expect(step4Text).not.toContain('web.search {"q":"DeepSeek 过去一年 模型发布"}');
      expect(isChronological(step4.rankedTaskBlocks.map((b) => b.startTime))).toBe(true);
    } finally {
      rmSync(setup.rootDir, { recursive: true, force: true });
    }
  });
});
