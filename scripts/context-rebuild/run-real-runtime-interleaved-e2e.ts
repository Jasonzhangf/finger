#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface StepCase {
  id: number;
  prompt: string;
  mustInclude: string[];
  mustExclude: string[];
}

interface MailboxMessage {
  id: string;
  status: string;
  content?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

type SessionSnapshotMessage = {
  id?: string;
  slot?: number;
  role: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
};

type LedgerSlotSummary = {
  slot: number;
  eventType: string;
  role: string;
  preview: string;
};

const BASE_URL = process.env.FINGER_BASE_URL?.trim() || 'http://127.0.0.1:9999';
const TARGET_AGENT = process.env.FINGER_TARGET_AGENT?.trim() || 'finger-system-agent';
const MAX_WAIT_MS = Number(process.env.FINGER_E2E_STEP_TIMEOUT_MS ?? 600000);
const POLL_INTERVAL_MS = Number(process.env.FINGER_E2E_POLL_INTERVAL_MS ?? 3000);

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preview(input: string, n = 200): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (normalized.length <= n) return normalized;
  return `${normalized.slice(0, n)}...`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  return {};
}

async function postMessage(payload: Record<string, unknown>): Promise<{ messageId: string }> {
  const response = await fetch(`${BASE_URL}/api/v1/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`POST /api/v1/message failed: ${response.status} ${body}`);
  }
  const data = await response.json() as { messageId?: string };
  if (!data.messageId) throw new Error('messageId missing from /api/v1/message response');
  return { messageId: data.messageId };
}

async function getMailboxMessage(messageId: string): Promise<MailboxMessage> {
  const response = await fetch(`${BASE_URL}/api/v1/mailbox/${messageId}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GET /api/v1/mailbox/${messageId} failed: ${response.status} ${body}`);
  }
  return await response.json() as MailboxMessage;
}

async function waitMailboxTerminal(messageId: string): Promise<MailboxMessage> {
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    const msg = await getMailboxMessage(messageId);
    if (msg.status === 'completed' || msg.status === 'failed') return msg;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`mailbox message timeout: ${messageId} > ${MAX_WAIT_MS}ms`);
}

async function fetchLedgerSlots(sessionId: string): Promise<LedgerSlotSummary[]> {
  const response = await fetch(`${BASE_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/ledger?limit=5000&offset=0`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GET ledger slots failed: ${response.status} ${body}`);
  }
  const data = await response.json() as { slots?: Array<Record<string, unknown>> };
  const rawSlots = Array.isArray(data.slots) ? data.slots : [];
  return rawSlots
    .map((slot) => ({
      slot: Number(slot.slot ?? 0),
      eventType: typeof slot.event_type === 'string' ? slot.event_type : '',
      role: typeof slot.role === 'string' ? slot.role : '',
      preview: typeof slot.content_preview === 'string' ? slot.content_preview : '',
    }))
    .filter((item) => Number.isFinite(item.slot) && item.slot > 0);
}

async function fetchLedgerSlotDetail(sessionId: string, slot: number): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/ledger/${slot}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GET ledger slot detail failed: ${response.status} ${body}`);
  }
  const data = await response.json() as { detail?: Record<string, unknown> };
  return asRecord(data.detail);
}

async function collectSessionMessages(sessionId: string, sessionSlots: LedgerSlotSummary[]): Promise<SessionSnapshotMessage[]> {
  const sessionMessageSlots = sessionSlots
    .filter((slot) => slot.eventType === 'session_message')
    .sort((a, b) => a.slot - b.slot);

  const messages: SessionSnapshotMessage[] = [];
  for (const item of sessionMessageSlots) {
    const detail = await fetchLedgerSlotDetail(sessionId, item.slot);
    const payload = asRecord(detail.payload);
    const role = typeof payload.role === 'string' ? payload.role : '';
    const content = typeof payload.content === 'string' ? payload.content : '';
    const timestamp = typeof detail.timestamp_iso === 'string' ? detail.timestamp_iso : nowIso();
    const metadata = asRecord(payload.metadata);
    if (role && content) {
      messages.push({
        id: typeof detail.id === 'string' ? detail.id : undefined,
        slot: item.slot,
        role,
        content,
        timestamp,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }
  }

  return messages;
}

function findPromptCutoff(messages: SessionSnapshotMessage[], prompt: string): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    if (message.content.includes(prompt)) return i;
  }
  return -1;
}

function isChronological(starts: number[]): boolean {
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i] < starts[i - 1]) return false;
  }
  return true;
}

function extractAssistantText(mailboxResult: MailboxMessage): string {
  const result = asRecord(mailboxResult.result);
  const raw = result.response;
  if (typeof raw === 'string') return raw;
  return mailboxResult.error ?? '';
}

function extractSessionId(mailboxResult: MailboxMessage): string | null {
  const result = asRecord(mailboxResult.result);
  if (typeof result.sessionId === 'string' && result.sessionId.trim().length > 0) return result.sessionId;

  const content = asRecord(mailboxResult.content);
  const metadata = asRecord(content.metadata);
  if (typeof metadata.sessionId === 'string' && metadata.sessionId.trim().length > 0) return metadata.sessionId;

  if (typeof content.sessionId === 'string' && content.sessionId.trim().length > 0) return content.sessionId;
  return null;
}

function detectToolCallLike(slot: LedgerSlotSummary): boolean {
  if (slot.eventType === 'tool_call' || slot.eventType === 'tool_result') return true;
  if (slot.eventType !== 'session_message') return false;
  const previewText = slot.preview.toLowerCase();
  return previewText.includes('调用工具') || previewText.includes('[toolcall]') || previewText.includes('tool_call');
}

function countToolCallsBetween(params: {
  allSlots: LedgerSlotSummary[];
  startSlot: number;
  endSlotExclusive: number;
}): number {
  const { allSlots, startSlot, endSlotExclusive } = params;
  return allSlots.filter((slot) => slot.slot > startSlot && slot.slot < endSlotExclusive && detectToolCallLike(slot)).length;
}

async function main(): Promise<void> {
  const sessionHint = `ctx-real-rebuild-${Date.now()}`;
  const reportDir = join(homedir(), '.finger', 'reports', 'context-rebuild-real-runtime', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(reportDir, { recursive: true });

  const steps: StepCase[] = [
    {
      id: 1,
      prompt: '话题一：请上网搜索并总结 DeepSeek 过去一年的进展。必须先 update_plan，再至少调用两次 web.search（不同 query），最后给出结论。',
      mustInclude: [],
      mustExclude: [],
    },
    {
      id: 2,
      prompt: '话题二：请上网搜索并总结阿里千问过去一年的进展。必须先 update_plan，再至少调用两次 web.search（不同 query），最后给出结论。',
      mustInclude: [],
      mustExclude: [],
    },
    {
      id: 3,
      prompt: '回到话题一：DeepSeek 上一次模型发布是什么，时间点是什么？回答前必须先用工具核验。',
      mustInclude: ['DeepSeek 过去一年', 'DeepSeek'],
      mustExclude: ['阿里千问过去一年'],
    },
    {
      id: 4,
      prompt: '回到话题二：阿里千问的最新模型是什么？回答前必须先用工具核验。',
      mustInclude: ['阿里千问', 'Qwen'],
      mustExclude: ['DeepSeek 过去一年'],
    },
  ];

  const runtimeStepResults: Array<Record<string, unknown>> = [];
  let canonicalSessionId: string | null = null;

  for (const step of steps) {
    const startedAt = Date.now();
    try {
      const post = await postMessage({
        target: TARGET_AGENT,
        sender: 'cli',
        blocking: false,
        message: {
          text: step.prompt,
          sessionId: canonicalSessionId ?? sessionHint,
        },
      });

      const terminal = await waitMailboxTerminal(post.messageId);
      const assistantText = extractAssistantText(terminal);
      const inferredSessionId = extractSessionId(terminal);
      if (!canonicalSessionId && inferredSessionId) canonicalSessionId = inferredSessionId;

      runtimeStepResults.push({
        step: step.id,
        prompt: step.prompt,
        messageId: post.messageId,
        status: terminal.status,
        elapsedMs: Date.now() - startedAt,
        sessionId: inferredSessionId,
        assistantPreview: preview(assistantText, 500),
        failedByKernel: assistantText.includes('"success":false') || assistantText.includes('run_turn failed'),
      });

      const latest = runtimeStepResults[runtimeStepResults.length - 1];
      if (latest?.failedByKernel === true) {
        const report = {
          ok: false,
          reason: 'runtime_kernel_failure',
          baseUrl: BASE_URL,
          targetAgent: TARGET_AGENT,
          canonicalSessionId,
          runtimeSteps: runtimeStepResults,
          generatedAt: nowIso(),
        };
        writeFileSync(join(reportDir, 'real-runtime-report.json'), JSON.stringify(report, null, 2), 'utf-8');
        console.log(reportDir);
        return;
      }
    } catch (error) {
      runtimeStepResults.push({
        step: step.id,
        prompt: step.prompt,
        status: 'failed',
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      const report = {
        ok: false,
        reason: 'runtime_step_failed',
        baseUrl: BASE_URL,
        targetAgent: TARGET_AGENT,
        canonicalSessionId,
        runtimeSteps: runtimeStepResults,
        generatedAt: nowIso(),
      };
      writeFileSync(join(reportDir, 'real-runtime-report.json'), JSON.stringify(report, null, 2), 'utf-8');
      console.log(reportDir);
      return;
    }
  }

  if (!canonicalSessionId) {
    const report = {
      ok: false,
      reason: 'canonical sessionId not found from mailbox results',
      baseUrl: BASE_URL,
      targetAgent: TARGET_AGENT,
      steps: runtimeStepResults,
      generatedAt: nowIso(),
    };
    writeFileSync(join(reportDir, 'real-runtime-report.json'), JSON.stringify(report, null, 2), 'utf-8');
    console.log(reportDir);
    return;
  }

  const { buildContext } = await import('../../src/runtime/context-builder.js');
  const { executeContextLedgerMemory } = await import('../../src/runtime/context-ledger-memory.js');

  const allSlots = await fetchLedgerSlots(canonicalSessionId);
  const sessionMessages = await collectSessionMessages(canonicalSessionId, allSlots);
  const stepUserSlots = steps.map((step) => {
    const hit = sessionMessages.find((message) => message.role === 'user' && message.content.includes(step.prompt));
    return { step: step.id, slot: hit?.slot ?? -1 };
  });

  const toolUsageChecks = stepUserSlots.map((item, index) => {
    const currentSlot = item.slot;
    const nextSlot = index + 1 < stepUserSlots.length && stepUserSlots[index + 1]?.slot && stepUserSlots[index + 1].slot > 0
      ? stepUserSlots[index + 1].slot
      : Number.MAX_SAFE_INTEGER;
    const toolCalls = currentSlot > 0
      ? countToolCallsBetween({ allSlots, startSlot: currentSlot, endSlotExclusive: nextSlot })
      : 0;
    return {
      step: item.step,
      userSlot: currentSlot,
      nextUserSlot: Number.isFinite(nextSlot) ? nextSlot : null,
      toolCallsBetweenTurns: toolCalls,
      passAtLeastTwo: toolCalls >= 2,
    };
  });

  const analysis: Array<Record<string, unknown>> = [];
  for (const step of steps.filter((item) => item.id === 3 || item.id === 4)) {
    const cutoff = findPromptCutoff(sessionMessages, step.prompt);
    const scoped = cutoff >= 0 ? sessionMessages.slice(0, cutoff + 1) : sessionMessages;

    const built = await buildContext(
      {
        rootDir: join(homedir(), '.finger', 'sessions'),
        sessionId: canonicalSessionId,
        agentId: TARGET_AGENT,
        mode: 'main',
        currentPrompt: step.prompt,
        sessionMessages: scoped,
      },
      {
        targetBudget: 200000,
        includeMemoryMd: false,
        enableTaskGrouping: true,
        enableModelRanking: true,
        rebuildTrigger: 'bootstrap_first',
        buildMode: 'aggressive',
        preferCompactHistory: false,
      },
    );

    const text = built.messages.map((m) => m.content).join('\n');
    const hitInclude = step.mustInclude.map((needle) => ({ needle, hit: text.includes(needle) }));
    const hitExclude = step.mustExclude.map((needle) => ({ needle, hit: text.includes(needle) }));

    analysis.push({
      step: step.id,
      prompt: step.prompt,
      selectedTags: built.metadata.selectedTags ?? [],
      historicalBlockIds: built.metadata.historicalBlockIds ?? [],
      workingSetBlockIds: built.metadata.workingSetBlockIds ?? [],
      rankingIds: built.metadata.rankingIds ?? [],
      orderingChecks: {
        rankedTaskBlocksChronological: isChronological(built.rankedTaskBlocks.map((b) => b.startTime)),
      },
      hitChecks: {
        mustInclude: hitInclude,
        mustExclude: hitExclude,
      },
      messagePreview: built.messages.slice(0, 12).map((m) => ({ role: m.role, content: preview(m.content, 160) })),
    });

    const file = join(reportDir, `analysis-step-${step.id}.json`);
    writeFileSync(file, JSON.stringify(analysis[analysis.length - 1], null, 2), 'utf-8');

    // render screenshot
    const render = await import('node:child_process');
    const proc = render.spawnSync(
      'python3',
      [
        'scripts/context-rebuild/render-evidence.py',
        '--input', file,
        '--output', join(reportDir, `analysis-step-${step.id}.png`),
        '--title', `Real Runtime Context Rebuild · Step ${step.id}`,
      ],
      { cwd: process.cwd(), stdio: 'inherit' },
    );
    if (proc.status !== 0) {
      throw new Error(`render screenshot failed for step ${step.id}`);
    }
  }

  const indexResult = await executeContextLedgerMemory({
    action: 'index',
    session_id: canonicalSessionId,
    agent_id: TARGET_AGENT,
    mode: 'main',
    full_reindex: true,
  });

  const report = {
    ok: true,
    baseUrl: BASE_URL,
    targetAgent: TARGET_AGENT,
    canonicalSessionId,
    runtimeSteps: runtimeStepResults,
    contextAnalysis: analysis,
    toolUsageChecks,
    ledgerIndexResult: indexResult,
    generatedAt: nowIso(),
  };

  writeFileSync(join(reportDir, 'real-runtime-report.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log(reportDir);
}

main().catch((error) => {
  const reportDir = join(homedir(), '.finger', 'reports', 'context-rebuild-real-runtime', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'fatal-error.txt'), error instanceof Error ? error.stack ?? error.message : String(error), 'utf-8');
  console.error(error instanceof Error ? error.message : String(error));
  console.log(reportDir);
  process.exitCode = 1;
});
