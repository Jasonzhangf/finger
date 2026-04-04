#!/usr/bin/env tsx
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

type SnapshotMessage = {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
};

type LedgerRuntime = {
  rootDir: string;
  sessionId: string;
  agentId: string;
  mode: string;
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function buildTimeline(baseMs: number): {
  step1: SnapshotMessage[];
  step2: SnapshotMessage[];
  step3: SnapshotMessage[];
  step4: SnapshotMessage[];
} {
  const step1: SnapshotMessage[] = [
    {
      id: 'u-deepseek-summary',
      role: 'user',
      content: '请上网搜索并总结 DeepSeek 过去一年的进展',
      timestamp: iso(baseMs),
    },
    {
      id: 'a-deepseek-plan',
      role: 'assistant',
      content: '先制定计划，再执行两轮工具查询（官方发布 + 社区汇总）。',
      timestamp: iso(baseMs + 10_000),
    },
    {
      id: 'a-deepseek-toolcall',
      role: 'assistant',
      content: '[toolcall] web.search {"q":"DeepSeek 过去一年 模型发布"}',
      timestamp: iso(baseMs + 12_000),
      metadata: { tags: ['deepseek', 'research'], topic: 'deepseek', toolName: 'web.search', toolStatus: 'success' },
    },
    {
      id: 'a-deepseek-summary',
      role: 'assistant',
      content: '[tool_result] 命中 12 条来源；已完成：DeepSeek 过去一年里发布了多轮模型与工具链更新。',
      timestamp: iso(baseMs + 20_000),
      metadata: { tags: ['deepseek', 'research'], topic: 'deepseek' },
    },
  ];

  const step2: SnapshotMessage[] = [
    ...step1,
    {
      id: 'u-qwen-summary',
      role: 'user',
      content: '请上网搜索并总结阿里千问过去一年的进展',
      timestamp: iso(baseMs + 60_000),
    },
    {
      id: 'a-qwen-plan',
      role: 'assistant',
      content: '按同样流程执行两轮工具查询（官网公告 + 生态更新）。',
      timestamp: iso(baseMs + 70_000),
    },
    {
      id: 'a-qwen-toolcall',
      role: 'assistant',
      content: '[toolcall] web.search {"q":"阿里千问 过去一年 模型发布"}',
      timestamp: iso(baseMs + 72_000),
      metadata: { tags: ['qwen', 'research'], topic: 'qwen', toolName: 'web.search', toolStatus: 'success' },
    },
    {
      id: 'a-qwen-summary',
      role: 'assistant',
      content: '[tool_result] 命中 15 条来源；已完成：阿里千问过去一年推出多条 Qwen 系列模型线。',
      timestamp: iso(baseMs + 80_000),
      metadata: { tags: ['qwen', 'research'], topic: 'qwen' },
    },
  ];

  const step3: SnapshotMessage[] = [
    ...step2,
    {
      id: 'u-deepseek-followup',
      role: 'user',
      content: '回到话题一：DeepSeek 上一次模型发布是什么，时间点是什么？',
      timestamp: iso(baseMs + 120_000),
    },
  ];

  const step4: SnapshotMessage[] = [
    ...step3,
    {
      id: 'a-deepseek-followup-toolcall',
      role: 'assistant',
      content: '[toolcall] web.search {"q":"DeepSeek 最新一次模型发布时间"}',
      timestamp: iso(baseMs + 130_000),
      metadata: { tags: ['deepseek', 'release'], topic: 'deepseek', toolName: 'web.search', toolStatus: 'success' },
    },
    {
      id: 'a-deepseek-followup',
      role: 'assistant',
      content: '[tool_result] 上一轮 DeepSeek 发布为 DeepSeek-V3.2，发布时间示例为 2026-02-10。',
      timestamp: iso(baseMs + 140_000),
      metadata: { tags: ['deepseek', 'release'], topic: 'deepseek' },
    },
    {
      id: 'u-qwen-followup',
      role: 'user',
      content: '回到话题二：阿里千问的最新模型是什么？',
      timestamp: iso(baseMs + 180_000),
    },
  ];

  return { step1, step2, step3, step4 };
}

function preview(content: string, limit = 80): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

function isChronological(numbers: number[]): boolean {
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] < numbers[i - 1]) return false;
  }
  return true;
}

function writeLedgerFromMessages(runtime: LedgerRuntime, messages: SnapshotMessage[]): void {
  const dir = join(runtime.rootDir, runtime.sessionId, runtime.agentId, runtime.mode);
  mkdirSync(dir, { recursive: true });
  const ledgerPath = join(dir, 'context-ledger.jsonl');
  const lines = messages.map((message) => {
    const timestampMs = Date.parse(message.timestamp);
    return JSON.stringify({
      id: message.id,
      timestamp_ms: timestampMs,
      timestamp_iso: message.timestamp,
      session_id: runtime.sessionId,
      agent_id: runtime.agentId,
      mode: runtime.mode,
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

async function main(): Promise<void> {
  const now = new Date();
  const stamp = `${now.toISOString().replace(/[:.]/g, '-')}`;
  const reportDir = join(homedir(), '.finger', 'reports', 'context-rebuild', stamp);
  mkdirSync(reportDir, { recursive: true });

  const tempHome = mkdtempSync(join(tmpdir(), 'finger-context-evidence-home-'));
  process.env.FINGER_HOME = tempHome;
  process.env.RANKER_TEST_KEY = 'dummy-key';

  const configDir = join(tempHome, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      kernel: {
        provider: 'ranker',
        providers: {
          ranker: {
            name: 'ranker-mock',
            base_url: 'https://ranker.example',
            wire_api: 'responses',
            env_key: 'RANKER_TEST_KEY',
            model: 'ranker-model',
            enabled: true,
          },
        },
      },
    }, null, 2),
    'utf-8',
  );

  const { buildContext } = await import('../../src/runtime/context-builder.js');

  const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestBody = typeof init?.body === 'string' ? init.body : '';
    let lowered = requestBody.toLowerCase();
    try {
      const parsed = JSON.parse(requestBody) as {
        input?: Array<{ role?: string; content?: Array<{ text?: string }> }>;
      };
      const userText = parsed?.input
        ?.filter((item) => item?.role === 'user')
        .flatMap((item) => item?.content ?? [])
        .map((part) => part?.text ?? '')
        .join('\n') ?? '';
      const matched = userText.match(/用户输入[:：]\s*([^\n]+)/);
      if (matched && typeof matched[1] === 'string') {
        lowered = matched[1].toLowerCase();
      }
    } catch {
      // keep raw lowered body
    }

    let selectedTag = 'deepseek';
    if (lowered.includes('千问') || lowered.includes('qwen')) {
      selectedTag = 'qwen';
    } else if (lowered.includes('deepseek')) {
      selectedTag = 'deepseek';
    }

    const payload = {
      output_text: JSON.stringify({ selectedTags: [selectedTag], selectedTaskIds: [] }),
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  globalThis.fetch = mockFetch as typeof fetch;

  const timeline = buildTimeline(Date.UTC(2026, 0, 15, 2, 0, 0));
  const runtime: LedgerRuntime = {
    rootDir: join(tempHome, 'sessions'),
    sessionId: 'ctx-rebuild-evidence',
    agentId: 'finger-system-agent',
    mode: 'main',
  };
  const steps: Array<{
    id: number;
    prompt: string;
    messages: SnapshotMessage[];
    mustInclude?: string[];
    mustExclude?: string[];
  }> = [
    { id: 1, prompt: '请上网搜索并总结 DeepSeek 过去一年的进展', messages: timeline.step1 },
    { id: 2, prompt: '请上网搜索并总结阿里千问过去一年的进展', messages: timeline.step2 },
    {
      id: 3,
      prompt: 'DeepSeek 上一次模型发布是什么，时间点是什么？',
      messages: timeline.step3,
      mustInclude: ['DeepSeek 过去一年的进展', 'web.search {"q":"DeepSeek 过去一年 模型发布"}'],
      mustExclude: ['阿里千问过去一年的进展', 'web.search {"q":"阿里千问 过去一年 模型发布"}'],
    },
    {
      id: 4,
      prompt: '阿里千问的最新模型是什么？',
      messages: timeline.step4,
      mustInclude: ['阿里千问过去一年的进展', 'web.search {"q":"阿里千问 过去一年 模型发布"}'],
      mustExclude: ['DeepSeek 过去一年的进展', 'web.search {"q":"DeepSeek 过去一年 模型发布"}'],
    },
  ];

  for (const step of steps) {
    writeLedgerFromMessages(runtime, step.messages);

    const result = await buildContext(
      {
        rootDir: runtime.rootDir,
        sessionId: runtime.sessionId,
        agentId: runtime.agentId,
        mode: runtime.mode,
        currentPrompt: step.prompt,
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

    const rankedBlocks = result.rankedTaskBlocks.map((block) => {
      const firstUser = block.messages.find((message) => message.role === 'user')?.content ?? '';
      return {
        id: block.id,
        startTime: block.startTime,
        startTimeIso: block.startTimeIso,
        topic: block.topic ?? null,
        tags: block.tags ?? [],
        firstUser: preview(firstUser, 120),
      };
    });

    const idToStart = new Map(rankedBlocks.map((block) => [block.id, block.startTime]));
    const historicalIds = Array.isArray(result.metadata.historicalBlockIds)
      ? result.metadata.historicalBlockIds.filter((id): id is string => typeof id === 'string')
      : [];
    const historicalStarts = historicalIds
      .map((id) => idToStart.get(id))
      .filter((n): n is number => typeof n === 'number');

    const output = {
      step: step.id,
      prompt: step.prompt,
      metadata: result.metadata,
      historicalBlockIds: historicalIds,
      workingSetBlockIds: Array.isArray(result.metadata.workingSetBlockIds)
        ? result.metadata.workingSetBlockIds
        : [],
      rankedTaskBlocks: rankedBlocks,
      orderingChecks: {
        rankedTaskBlocksChronological: isChronological(rankedBlocks.map((block) => block.startTime)),
        historicalIdsChronological: isChronological(historicalStarts),
      },
      hitChecks: {
        mustInclude: (step.mustInclude ?? []).map((needle) => ({
          needle,
          hit: result.messages.some((message) => message.content.includes(needle)),
        })),
        mustExclude: (step.mustExclude ?? []).map((needle) => ({
          needle,
          hit: result.messages.some((message) => message.content.includes(needle)),
        })),
      },
      messagePreview: result.messages.slice(0, 10).map((message) => ({
        role: message.role,
        content: preview(message.content, 120),
      })),
    };

    const jsonPath = join(reportDir, `step-${step.id}.json`);
    const pngPath = join(reportDir, `step-${step.id}.png`);
    writeFileSync(jsonPath, JSON.stringify(output, null, 2), 'utf-8');

    const render = spawnSync(
      'python3',
      [
        'scripts/context-rebuild/render-evidence.py',
        '--input',
        jsonPath,
        '--output',
        pngPath,
        '--title',
        `Context Rebuild Evidence · Step ${step.id}`,
      ],
      { cwd: process.cwd(), stdio: 'inherit' },
    );
    if (render.status !== 0) {
      throw new Error(`Failed to render screenshot for step ${step.id}`);
    }
  }

  console.log(reportDir);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
