/**
 * RuntimeFacade - 统一运行时门面
 * 提供给基础子 Agent 使用的统一接口
 */

import type { WebSocket } from 'ws';
import { readProjectState, getDefaultEnabledAgents } from "./project-state.js";
import path from 'path';
import { FINGER_PATHS, ensureDir } from '../core/finger-paths.js';
import { UnifiedEventBus } from './event-bus.js';
import { ToolRegistry } from './tool-registry.js';
import type { RuntimeEvent } from './events.js';
import type { Attachment } from '../bridges/types.js';
import { AgentToolAccessControl, type AgentToolPolicy } from './agent-tool-access.js';
import { applyRoleToolPolicy, type RoleToolPolicyPresetMap } from './agent-tool-role-policy.js';
import {
  ToolAuthorizationManager,
  type AuthorizationIssueOptions,
  type ToolAuthorizationGrant,
} from './tool-authorization.js';
import { executeContextLedgerMemory } from './context-ledger-memory.js';
import { SessionControlPlaneStore } from './session-control-plane.js';
import { SYSTEM_PROJECT_PATH } from '../agents/finger-system-agent/index.js';
import {
  getCompactionPrompt,
  parseCompactionOutput,
  validateSummary,
} from '../agents/prompts/compaction-prompts.js';
import {
  buildProviderHeaders,
  buildResponsesEndpoints,
  resolveKernelProvider,
} from '../core/kernel-provider-client.js';
import { loadContextBuilderSettings } from '../core/user-settings.js';

import { logger } from '../core/logger.js';

// Session 类型 (简化版，完整定义在 session-manager.ts)
export interface SessionInfo {
  id: string;
  name: string;
  projectPath: string;
  status?: 'active' | 'paused' | 'completed' | 'error';
  messageCount?: number;
  createdAt: string;
  updatedAt: string;
  context?: Record<string, unknown>;
}

// 进度报告
export interface ProgressReport {
  overall: number;
  activeAgents: string[];
  pending: number;
  completed: number;
  failed: number;
}

// 会话管理器接口
export interface ISessionManager {
  createSession(projectPath: string, name?: string): SessionInfo | Promise<SessionInfo>;
  getSession(sessionId: string): SessionInfo | undefined;
  getCurrentSession(): SessionInfo | null;
  setCurrentSession(sessionId: string): boolean;
  listSessions(): SessionInfo[];
  addMessage(sessionId: string, role: string, content: string, metadata?: { attachments?: Attachment[] }): Promise<{ id: string; timestamp: string } | null>;
  getMessages(
    sessionId: string,
    limit?: number,
  ): Array<{
    id: string;
    role: string;
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
    attachments?: Attachment[];
  }>;
  deleteSession(sessionId: string): boolean;
  pauseSession?(sessionId: string): boolean;
  resumeSession?(sessionId: string): boolean;
  updateContext?(sessionId: string, context: Record<string, unknown>): boolean;
  compressContext?(sessionId: string, summarizer?: unknown): Promise<string>;
  getCompressionStatus?(sessionId: string): { compressed: boolean; summary?: string; originalCount?: number };
  isPaused?(sessionId: string): boolean;
}

export interface AgentProviderRuntimeConfig {
  type: string;
  model?: string;
  options?: Record<string, unknown>;
}

export interface AgentSessionRuntimeConfig {
  bindingScope?: 'finger' | 'finger+agent';
  resume?: boolean;
  provider?: string;
  agentId?: string;
  mapPath?: string;
}

export interface AgentIflowGovernanceRuntimeConfig {
  allowedTools?: string[];
  disallowedTools?: string[];
  approvalMode?: 'default' | 'autoEdit' | 'yolo' | 'plan';
  injectCapabilities?: boolean;
  capabilityIds?: string[];
  commandNamespace?: string;
}

export interface AgentGovernanceRuntimeConfig {
  iflow?: AgentIflowGovernanceRuntimeConfig;
}

export interface AgentRuntimeConfig {
  id: string;
  name?: string;
  role?: string;
  provider?: AgentProviderRuntimeConfig;
  session?: AgentSessionRuntimeConfig;
  governance?: AgentGovernanceRuntimeConfig;
  prompts?: {
    system?: string;
    developer?: string;
  };
  model?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const log = logger.module('RuntimeFacade');
const AUTO_CONTEXT_COMPACT_THRESHOLD_PERCENT = Number.isFinite(Number(process.env.FINGER_CONTEXT_AUTO_COMPACT_THRESHOLD_PERCENT))
  ? Math.max(1, Math.min(100, Math.floor(Number(process.env.FINGER_CONTEXT_AUTO_COMPACT_THRESHOLD_PERCENT))))
  : 85;
const AUTO_CONTEXT_COMPACT_COOLDOWN_MS = Number.isFinite(Number(process.env.FINGER_CONTEXT_AUTO_COMPACT_COOLDOWN_MS))
  ? Math.max(1_000, Math.floor(Number(process.env.FINGER_CONTEXT_AUTO_COMPACT_COOLDOWN_MS)))
  : 60_000;
const autoCompactStateBySession = new Map<string, { lastAttemptAt: number; lastTurnId?: string }>();
const autoCompactInFlightBySession = new Map<string, Promise<boolean>>();
const autoDigestStopStateBySession = new Map<string, { lastAttemptAt: number; lastTurnId?: string }>();
const autoDigestStopInFlightBySession = new Map<string, Promise<boolean>>();
const COMPACTION_PROMPT_PRESERVE_RECENT_COUNT = 8;

interface CompactDigestTask {
  id: string;
  task_id: string;
  start_time_iso: string;
  end_time_iso: string;
  request: string;
  summary: string;
  key_tools: string[];
  tool_calls?: Array<{
    tool: string;
    input?: string;
    status: 'success' | 'failure' | 'unknown';
    output?: string;
  }>;
  key_reads: string[];
  key_writes: string[];
  tags?: string[];
  topic?: string;
}

interface CompactionModelAttemptResult {
  summary?: string;
  reason: string;
  providerId: string;
  providerModel?: string;
}

function truncateInline(text: string, max = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function normalizePathHint(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('~')) return trimmed;
  if (trimmed.startsWith('/')) return trimmed;
  if (trimmed.includes('/')) return trimmed;
  return trimmed;
}

function extractReadWritePaths(command: string): { reads: string[]; writes: string[] } {
  const tokens = command.match(/[^\s|;'"<>]+/g) || [];
  const reads = new Set<string>();
  const writes = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.startsWith('-')) continue;
    const normalized = normalizePathHint(token);
    if (!normalized || (!normalized.includes('/') && !/\.[a-zA-Z0-9]{1,8}$/.test(normalized))) continue;
    const prev = tokens[index - 1] ?? '';
    const next = tokens[index + 1] ?? '';
    if (prev === '>' || prev === '>>' || next === '>' || next === '>>') {
      writes.add(normalized);
      continue;
    }
    reads.add(normalized);
  }
  return {
    reads: Array.from(reads).slice(0, 8),
    writes: Array.from(writes).slice(0, 8),
  };
}

function buildCompactReplacementHistory(messages: Array<Record<string, unknown>>): CompactDigestTask[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const tasks: Array<{
    startAt: string;
    endAt: string;
    entries: Array<Record<string, unknown>>;
  }> = [];
  let current: { startAt: string; endAt: string; entries: Array<Record<string, unknown>> } | null = null;

  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : 'user';
    const timestamp = typeof message.timestamp === 'string' ? message.timestamp : new Date().toISOString();
    if (role === 'user' && current && current.entries.length > 0) {
      tasks.push(current);
      current = {
        startAt: timestamp,
        endAt: timestamp,
        entries: [message],
      };
      continue;
    }
    if (!current) {
      current = {
        startAt: timestamp,
        endAt: timestamp,
        entries: [message],
      };
      continue;
    }
    current.entries.push(message);
    current.endAt = timestamp;
  }
  if (current && current.entries.length > 0) tasks.push(current);

  return tasks.map((task, index) => {
    const firstUser = task.entries.find((entry) => entry.role === 'user');
    const request = typeof firstUser?.content === 'string' ? truncateInline(firstUser.content, 220) : '(no user request)';
    const lastAssistant = [...task.entries].reverse().find((entry) => entry.role === 'assistant' || entry.role === 'orchestrator');
    const summary = typeof lastAssistant?.content === 'string' && lastAssistant.content.trim().length > 0
      ? lastAssistant.content.trim()
      : 'Task executed without assistant completion summary.';
    const toolSet = new Set<string>();
    const readSet = new Set<string>();
    const writeSet = new Set<string>();
    const tagSet = new Set<string>();
    const toolCalls: Array<{ tool: string; input?: string; status: 'success' | 'failure' | 'unknown'; output?: string }> = [];
    let topic: string | undefined;

    for (const entry of task.entries) {
      const toolName = typeof entry.toolName === 'string' ? entry.toolName.trim() : '';
      if (toolName) toolSet.add(toolName);
      const metadata = entry.metadata && typeof entry.metadata === 'object'
        ? entry.metadata as Record<string, unknown>
        : undefined;
      const tags = metadata?.tags;
      if (Array.isArray(tags)) {
        for (const tag of tags) {
          if (typeof tag === 'string' && tag.trim().length > 0) tagSet.add(tag.trim());
        }
      }
      if (!topic && typeof metadata?.topic === 'string' && metadata.topic.trim().length > 0) {
        topic = metadata.topic.trim();
      }
      const toolInput = typeof entry.toolInput === 'string'
        ? entry.toolInput
        : entry.toolInput !== undefined
          ? JSON.stringify(entry.toolInput)
          : '';
      const content = typeof entry.content === 'string' ? entry.content : '';
      const text = `${content}\n${toolInput}`;
      const extracted = extractReadWritePaths(text);
      for (const read of extracted.reads) readSet.add(read);
      for (const write of extracted.writes) writeSet.add(write);

      if (toolName) {
        const statusRaw = typeof entry.toolStatus === 'string' ? entry.toolStatus.trim().toLowerCase() : '';
        const status: 'success' | 'failure' | 'unknown' = statusRaw === 'success' || statusRaw === 'ok'
          ? 'success'
          : statusRaw === 'failure' || statusRaw === 'error' || statusRaw === 'failed'
            ? 'failure'
            : 'unknown';
        const inputText = typeof entry.toolInput === 'string'
          ? entry.toolInput.trim()
          : entry.toolInput !== undefined
            ? JSON.stringify(entry.toolInput)
            : '';
        const outputText = typeof entry.toolOutput === 'string'
          ? entry.toolOutput.trim()
          : entry.toolOutput !== undefined
            ? JSON.stringify(entry.toolOutput)
            : '';
        const keepVerboseOutput = toolName === 'update_plan'
          || toolName === 'reasoning.stop'
          || toolName === 'report-task-completion';
        toolCalls.push({
          tool: toolName,
          status,
          ...(inputText.length > 0 ? { input: truncateInline(inputText, 400) } : {}),
          ...(keepVerboseOutput && outputText.length > 0 ? { output: outputText } : {}),
        });
      }
    }

    const taskId = `task-${Date.parse(task.startAt) || Date.now()}-${index + 1}`;
    return {
      id: taskId,
      task_id: taskId,
      start_time_iso: task.startAt,
      end_time_iso: task.endAt,
      request,
      summary,
      key_tools: Array.from(toolSet),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      key_reads: Array.from(readSet).slice(0, 8),
      key_writes: Array.from(writeSet).slice(0, 8),
      ...(tagSet.size > 0 ? { tags: Array.from(tagSet).slice(0, 12) } : {}),
      ...(topic ? { topic } : {}),
    };
  });
}

function extractResponseOutputText(data: Record<string, unknown>): string {
  const outputText = data.output_text;
  if (typeof outputText === 'string' && outputText.trim().length > 0) return outputText;
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as Array<Record<string, unknown>>
      : [];
    for (const c of content) {
      const text = c?.text;
      if (typeof text === 'string' && text.trim().length > 0) return text;
    }
  }
  return '';
}

function buildFallbackCompactionSummary(messages: Array<{ role: string; content: string }>): string {
  const userMessages = messages
    .filter((item) => item.role === 'user' && item.content.trim().length > 0)
    .map((item) => truncateInline(item.content, 220))
    .slice(-24);
  const assistantMessages = messages
    .filter((item) => item.role === 'assistant' && item.content.trim().length > 0)
    .map((item) => truncateInline(item.content, 220))
    .slice(-24);
  const recentWork = messages
    .slice(-10)
    .map((item, index) => `${index + 1}. [${item.role}] ${truncateInline(item.content, 140)}`);
  const filePathMatches = Array.from(
    new Set(
      messages
        .flatMap((item) => item.content.match(/(?:~\/|\/)[^\s"'`]+/g) ?? [])
        .slice(0, 40),
    ),
  );
  const errorHighlights = messages
    .map((item) => item.content)
    .filter((content) => /(error|failed|timeout|exception|traceback)/i.test(content))
    .map((content) => truncateInline(content, 200))
    .slice(-12);
  const primaryIntent = userMessages.length > 0
    ? userMessages[userMessages.length - 1]
    : 'No explicit user intent found in compressible messages.';

  return [
    '1. **Primary Request and Intent**:',
    `   ${primaryIntent}`,
    '',
    '2. **Key Technical Concepts**:',
    '   - Session compaction fallback summary',
    '   - Deterministic digest preserved when provider compaction is unavailable',
    '',
    '3. **Files and Code Sections**:',
    filePathMatches.length > 0
      ? `   - ${filePathMatches.join('\n   - ')}`
      : '   - No explicit file paths detected in compacted window.',
    '',
    '4. **Errors and Fixes**:',
    errorHighlights.length > 0
      ? `   - ${errorHighlights.join('\n   - ')}`
      : '   - No explicit error snippets captured.',
    '',
    '5. **Problem Solving**:',
    assistantMessages.length > 0
      ? `   - ${assistantMessages.slice(-8).join('\n   - ')}`
      : '   - No assistant problem-solving summaries captured.',
    '',
    '6. **All User Messages**:',
    userMessages.length > 0
      ? `   - ${userMessages.join('\n   - ')}`
      : '   - No user messages captured.',
    '',
    '7. **Pending Tasks**:',
    '   - Pending tasks must be inferred from latest user request and unfinished execution evidence.',
    '',
    '8. **Current Work**:',
    recentWork.length > 0
      ? `   - ${recentWork.join('\n   - ')}`
      : '   - No recent work entries captured.',
    '',
    '9. **Optional Next Step**:',
    '   - Resume from latest unfinished task and verify with evidence before closure.',
  ].join('\n');
}

function resolveCompactionProviderCandidates(): string[] {
  const contextBuilderSettings = loadContextBuilderSettings();
  const preferredProviderId = typeof contextBuilderSettings.rankingProviderId === 'string'
    ? contextBuilderSettings.rankingProviderId.trim()
    : '';
  const defaultProviderId = resolveKernelProvider(undefined).provider?.id?.trim() ?? '';
  return [preferredProviderId, defaultProviderId]
    .filter((item, index, arr): item is string => item.length > 0 && arr.indexOf(item) === index);
}

async function summarizeCompactionWithProvider(
  providerId: string,
  prompt: string,
): Promise<CompactionModelAttemptResult> {
  const providerResolved = resolveKernelProvider(providerId);
  const provider = providerResolved.provider;
  if (!provider) {
    return { providerId, reason: providerResolved.reason ?? 'provider_not_found' };
  }
  if (provider.enabled === false) {
    return {
      providerId,
      providerModel: provider.model,
      reason: 'provider_disabled',
    };
  }
  if (provider.wire_api !== 'responses') {
    return {
      providerId,
      providerModel: provider.model,
      reason: `unsupported_wire_api:${provider.wire_api}`,
    };
  }

  const payload = {
    model: provider.model,
    reasoning: { effort: 'minimal' },
    text: { verbosity: 'low' },
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: prompt,
          },
        ],
      },
    ],
  };

  try {
    const endpoints = buildResponsesEndpoints(provider.base_url);
    if (endpoints.length === 0) {
      return { providerId, providerModel: provider.model, reason: 'provider_base_url_missing' };
    }
    const headers = buildProviderHeaders(provider);
    let response: Response | null = null;
    for (const endpoint of endpoints) {
      const candidate = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (candidate.status === 404) {
        response = candidate;
        continue;
      }
      response = candidate;
      break;
    }
    if (!response || !response.ok) {
      return {
        providerId,
        providerModel: provider.model,
        reason: response ? `http_${response.status}` : 'http_unknown',
      };
    }
    const data = await response.json() as Record<string, unknown>;
    const outputText = extractResponseOutputText(data);
    if (!outputText) {
      return {
        providerId,
        providerModel: provider.model,
        reason: 'empty_output',
      };
    }
    const parsed = parseCompactionOutput(outputText);
    const normalizedSummary = typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
      ? parsed.summary.trim()
      : outputText.trim();
    if (!normalizedSummary) {
      return {
        providerId,
        providerModel: provider.model,
        reason: 'empty_summary',
      };
    }
    const validation = validateSummary(normalizedSummary);
    if (!validation.complete) {
      return {
        providerId,
        providerModel: provider.model,
        reason: `incomplete_summary:${validation.missing.join('|')}`,
      };
    }
    return {
      providerId,
      providerModel: provider.model,
      summary: normalizedSummary,
      reason: 'ok',
    };
  } catch {
    return {
      providerId,
      providerModel: provider.model,
      reason: 'exception',
    };
  }
}

function createCompactionSummarizer(params: {
  sessionId: string;
  trigger?: 'manual' | 'auto';
  contextUsagePercent?: number;
}): ((messages: Array<{ role: string; content: string }>) => Promise<string>) | undefined {
  if (params.trigger === 'auto') {
    // 上下文超限自动压缩：走无模型 deterministic digest，避免引入额外模型不稳定性/延迟。
    return undefined;
  }
  const providerCandidates = resolveCompactionProviderCandidates();
  if (providerCandidates.length === 0) return undefined;

  return async (messages: Array<{ role: string; content: string }>): Promise<string> => {
    const normalizedMessages = Array.isArray(messages)
      ? messages
        .filter((item) => typeof item.content === 'string' && item.content.trim().length > 0)
        .map((item) => ({
          role: typeof item.role === 'string' && item.role.trim().length > 0 ? item.role.trim() : 'user',
          content: item.content,
        }))
      : [];
    if (normalizedMessages.length === 0) return 'No compressible messages';

    const compactionPrompt = getCompactionPrompt({
      messages: normalizedMessages,
      preserveRecentCount: COMPACTION_PROMPT_PRESERVE_RECENT_COUNT,
      customInstructions: [
        `session_id=${params.sessionId}`,
        `trigger=${params.trigger ?? 'manual'}`,
        typeof params.contextUsagePercent === 'number' && Number.isFinite(params.contextUsagePercent)
          ? `context_usage_percent=${Math.floor(params.contextUsagePercent)}`
          : '',
        'Preserve task lifecycle markers (update_plan, agent.dispatch, review result, task result) in summary.',
      ].filter((line) => line.length > 0).join('\n'),
    });

    const attempts: string[] = [];
    for (const providerId of providerCandidates) {
      const attempted = await summarizeCompactionWithProvider(providerId, compactionPrompt);
      if (typeof attempted.summary === 'string' && attempted.summary.trim().length > 0) {
        return attempted.summary;
      }
      attempts.push(`${attempted.providerId}:${attempted.reason}`);
    }

    log.warn('Compaction summarizer provider attempts exhausted; fallback to deterministic digest summary', {
      sessionId: params.sessionId,
      trigger: params.trigger ?? 'manual',
      contextUsagePercent: params.contextUsagePercent,
      attempts,
    });
    return buildFallbackCompactionSummary(normalizedMessages);
  };
}

export class RuntimeFacade {
  private currentSessionId: string | null = null;
  private readonly agentSessionBindings = new Map<string, string>();
  private readonly sessionControlPlaneStore = new SessionControlPlaneStore();
  private readonly toolAccessControl = new AgentToolAccessControl();
  private readonly toolAuthorization = new ToolAuthorizationManager();
  private roleToolPolicyPresets: RoleToolPolicyPresetMap = {};
  private readonly agentRuntimeConfigs = new Map<string, AgentRuntimeConfig>();

  constructor(
    private eventBus: UnifiedEventBus,
    private sessionManager: ISessionManager,
    private toolRegistry: ToolRegistry,
  private wsClients?: Set<WebSocket>,
  ) {
    // 如果提供了 wsClients，注册到 eventBus
    if (wsClients) {
      // eventBus 将在发送时直接检查 wsClients
    }
  }

  private isEphemeralDispatchSessionId(sessionId: string): boolean {
    return /^dispatch-/i.test(sessionId.trim());
  }

  private isSystemAgent(agentId: string): boolean {
    return agentId.trim() === 'finger-system-agent';
  }

  private isSessionAllowedForAgent(agentId: string, session: SessionInfo): boolean {
    const normalizedAgentId = agentId.trim();
    const context = (session.context && typeof session.context === 'object')
      ? (session.context as Record<string, unknown>)
      : {};
    const ownerAgentId = typeof context.ownerAgentId === 'string' ? context.ownerAgentId.trim() : '';
    const sessionTier = typeof context.sessionTier === 'string' ? context.sessionTier.trim().toLowerCase() : '';
    const isSystemSession = session.projectPath === SYSTEM_PROJECT_PATH
      || sessionTier === 'system'
      || ownerAgentId === 'finger-system-agent'
      || session.id.startsWith('system-');

    if (ownerAgentId && ownerAgentId !== normalizedAgentId) {
      return false;
    }
    if (this.isSystemAgent(normalizedAgentId)) {
      return isSystemSession;
    }
    return !isSystemSession;
  }

  private isBindableSessionId(agentId: string, sessionId: string): boolean {
    const normalized = sessionId.trim();
    if (normalized.length === 0) return false;
    if (normalized === 'default') return false;
    if (this.isEphemeralDispatchSessionId(normalized)) return false;
    const session = this.sessionManager.getSession(normalized);
    if (!session) return false;
    return this.isSessionAllowedForAgent(agentId, session);
  }

  private sanitizeToolSessionCandidate(
    agentId: string,
    candidate: string | null | undefined,
    source: string,
    options?: { suppressWarn?: boolean },
  ): string | null {
    if (!candidate) return null;
    const normalized = candidate.trim();
    if (!normalized) return null;
    if (this.isBindableSessionId(agentId, normalized)) return normalized;
    if (!options?.suppressWarn) {
      log.warn('Ignored invalid tool session candidate', {
        agentId,
        source,
        sessionId: normalized,
        reason: this.isEphemeralDispatchSessionId(normalized)
          ? 'ephemeral_dispatch_id_forbidden'
          : 'session_not_found_or_agent_scope_forbidden',
      });
    }
    return null;
  }

  private resolvePersistedAgentSessionBinding(agentId: string): string | null {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) return null;
    try {
      const records = this.sessionControlPlaneStore.list({ agentId: normalizedAgentId, provider: 'finger' });
      for (const record of records) {
        const candidate = this.sanitizeToolSessionCandidate(
          normalizedAgentId,
          record.fingerSessionId,
          'callTool.persistedAgentBinding',
          { suppressWarn: true },
        );
        if (candidate) return candidate;
      }
    } catch (error) {
      log.warn('Failed to resolve persisted agent-session binding', {
        agentId: normalizedAgentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  // ==================== Session 管理 ====================

  /**
   * 创建会话
   */
  async createSession(projectPath: string, name?: string): Promise<SessionInfo> {
    const result = this.sessionManager.createSession(projectPath, name);
    const session = result instanceof Promise ? await result : result;
    this.currentSessionId = session.id;
    this.eventBus.enablePersistence(session.id, ensureDir(FINGER_PATHS.runtime.eventsDir));

    await this.eventBus.emit({
      type: 'session_created',
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      payload: {
        name: session.name,
        projectPath: session.projectPath,
        messageCount: 0,
      },
    });

    const projectState = readProjectState(projectPath);
    const enabledAgents = projectState?.enabledAgents ?? getDefaultEnabledAgents();
    void enabledAgents;
    // TODO: Auto-start orchestrator and other enabled agents based on project state.

    return session;
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessionManager.getSession(sessionId);
  }

  /**
   * 获取当前会话
   */
  getCurrentSession(): SessionInfo | null {
    return this.sessionManager.getCurrentSession();
  }

  /**
   * 设置当前会话
   */
  setCurrentSession(sessionId: string): boolean {
    if (this.isEphemeralDispatchSessionId(sessionId)) {
      log.warn('Rejected runtime current-session switch to ephemeral dispatch id', { sessionId });
      return false;
    }
    if (!this.sessionManager.getSession(sessionId)) {
      log.warn('Rejected runtime current-session switch to non-existent session', { sessionId });
      return false;
    }
    const result = this.sessionManager.setCurrentSession(sessionId);
    if (result) {
      this.currentSessionId = sessionId;
      this.eventBus.enablePersistence(sessionId, ensureDir(FINGER_PATHS.runtime.eventsDir));
    }
    return result;
  }

  /**
   * 列出所有会话
   */
  listSessions(): SessionInfo[] {
    return this.sessionManager.listSessions();
  }

  /**
   * Merge partial context fields into a session context and persist.
   */
  updateSessionContext(sessionId: string, context: Record<string, unknown>): boolean {
    if (typeof this.sessionManager.updateContext !== 'function') return false;
    return this.sessionManager.updateContext(sessionId, context);
  }

  /**
   * 获取会话消息（Ledger 动态视图）
   */
  getMessages(
    sessionId: string,
    limit?: number,
  ): Array<{
    id: string;
    role: string;
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
    attachments?: Attachment[];
  }> {
    return this.sessionManager.getMessages(sessionId, limit);
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): boolean {
    const result = this.sessionManager.deleteSession(sessionId);
    if (result && this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
    return result;
  }

  // ==================== 消息管理 ====================

  /**
   * 发送用户消息
   */
  async sendMessage(
    sessionId: string,
    content: string,
    attachments?: Attachment[],
  ): Promise<{ messageId: string }> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const message = await this.sessionManager.addMessage(sessionId, 'user', content, { attachments });
    if (!message) {
      throw new Error(`Failed to append message to session ${sessionId}`);
    }

    await this.eventBus.emit({
      type: 'user_message',
      sessionId,
      timestamp: message.timestamp,
      payload: {
        messageId: message.id,
        content,
        attachments,
      },
    });

    return { messageId: message.id };
  }

  /**
   * 添加助手消息块 (流式)
   */
  emitAssistantChunk(sessionId: string, agentId: string, messageId: string, content: string): void {
    void this.eventBus.emit({
      type: 'assistant_chunk',
      sessionId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: {
        messageId,
        content,
      },
    });
  }

  /**
   * 添加助手消息完成
   */
  emitAssistantComplete(sessionId: string, agentId: string, messageId: string, content: string, stopReason?: string): void {
    const session = this.sessionManager.getSession(sessionId);
    const context = session?.context as Record<string, unknown> | undefined;
    if (context && context.sessionTier === 'runtime') {
      void this.sessionManager.addMessage(sessionId, 'assistant', content);
    }
    void this.eventBus.emit({
      type: 'assistant_complete',
      sessionId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: {
        messageId,
        content,
        stopReason,
      },
    });
  }

  // ==================== 工具调用 ====================

  /**
   * 调用工具
   */
  async callTool(
    agentId: string,
    toolName: string,
    input: unknown,
    options: { authorizationToken?: string; sessionId?: string } = {},
  ): Promise<unknown> {
    const startTime = Date.now();
    const toolId = `${agentId}-${toolName}-${startTime}`;
    const optionSessionId = this.sanitizeToolSessionCandidate(
      agentId,
      typeof options.sessionId === 'string' ? options.sessionId : null,
      'callTool.options.sessionId',
    );
    const boundSessionId = this.sanitizeToolSessionCandidate(
      agentId,
      this.agentSessionBindings.get(agentId) ?? null,
      'callTool.boundAgentSession',
    );
    const persistedSessionId = this.resolvePersistedAgentSessionBinding(agentId);
    const sessionId = optionSessionId
      ?? boundSessionId
      ?? persistedSessionId
      ?? 'default';
    if (sessionId !== 'default') {
      this.agentSessionBindings.set(agentId, sessionId);
    }

    const access = this.toolAccessControl.canUse(agentId, toolName);
    if (!access.allowed) {
      this.eventBus.emit({
        type: 'tool_error',
        toolId,
        toolName,
        agentId,
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { error: access.reason, duration: 0 },
      });
      return {
        __tool_access_denied: true,
        error: access.reason,
        toolName,
        agentId,
        suggestion: '工具访问被拒绝。请检查权限配置或联系管理员。',
      };
    }

    // 检查策略
    const policy = this.toolRegistry.getPolicy(toolName);
    if (policy === 'deny') {
      return {
        __tool_policy_denied: true,
        error: `Tool ${toolName} is not allowed by policy`,
        toolName,
        agentId,
        suggestion: '工具被策略禁止。请检查 channels.json 中的工具策略配置。',
      };
    }

    if (this.toolAuthorization.isToolRequired(toolName)) {
      let token = options.authorizationToken;
      if (!token || token.trim().length === 0) {
        const grant = this.toolAuthorization.issue(agentId, toolName, 'system-auto', {
          ttlMs: 60_000,
          maxUses: 1,
        });
        token = grant.token;
      }

      const auth = this.toolAuthorization.verifyAndConsume(token, agentId, toolName);
    if (!auth.allowed) {
      this.eventBus.emit({
        type: 'tool_error',
        toolId,
        toolName,
        agentId,
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { error: auth.reason, duration: 0 },
      });
      return {
        __authorization_required: true,
        error: auth.reason,
        toolName,
        agentId,
        suggestion: '需要用户授权才能执行此命令。调用 permission.check 检查权限，或让用户回复授权码 <##auth:approvalId##>',
      };
    }
    }

    // 发送 tool_call 事件
    await this.eventBus.emit({
      type: 'tool_call',
      toolId,
      toolName,
      agentId,
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { input },
    });

    try {
      const executionInput = (
        toolName === 'context_builder.rebuild'
        && typeof input === 'object'
        && input !== null
        && !Array.isArray(input)
      )
        ? (() => {
            const payload = { ...(input as Record<string, unknown>) };
            const runtimeContextRaw = (
              typeof payload._runtime_context === 'object'
              && payload._runtime_context !== null
              && !Array.isArray(payload._runtime_context)
            )
              ? (payload._runtime_context as Record<string, unknown>)
              : {};
            const hasSessionMessages = Array.isArray(runtimeContextRaw.session_messages);
            if (!hasSessionMessages) {
              runtimeContextRaw.session_messages = this.sessionManager.getMessages(sessionId, 0);
            }
            if (typeof runtimeContextRaw.session_id !== 'string' || runtimeContextRaw.session_id.trim().length === 0) {
              runtimeContextRaw.session_id = sessionId;
            }
            if (typeof runtimeContextRaw.agent_id !== 'string' || runtimeContextRaw.agent_id.trim().length === 0) {
              runtimeContextRaw.agent_id = agentId;
            }
            payload._runtime_context = runtimeContextRaw;
            return payload;
          })()
        : input;

      const result = await this.toolRegistry.execute(toolName, executionInput, {
        agentId,
        sessionId,
      });
      const duration = Date.now() - startTime;

      // 发送 tool_result 事件
      await this.eventBus.emit({
        type: 'tool_result',
        toolId,
        toolName,
        agentId,
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { input: executionInput, output: result, duration },
      });

      if (toolName === 'view_image') {
        await this.appendViewImageAttachmentEvent(sessionId, result);
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      // 发送 tool_error 事件
      await this.eventBus.emit({
        type: 'tool_error',
        toolId,
        toolName,
        agentId,
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { input, error: String(error), duration },
      });

      throw error;
    }
  }

  /**
   * Bind an agent to a session as the preferred tool-execution context.
   * This avoids cross-turn/cross-agent session drift when tool requests do not carry sessionId.
   */
  bindAgentSession(agentId: string, sessionId: string): void {
    const normalizedAgentId = agentId.trim();
    const normalizedSessionId = sessionId.trim();
    if (normalizedAgentId.length === 0 || normalizedSessionId.length === 0) return;
    if (!this.isBindableSessionId(normalizedAgentId, normalizedSessionId)) {
      log.warn('Rejected agent-session binding', {
        agentId: normalizedAgentId,
        sessionId: normalizedSessionId,
        reason: this.isEphemeralDispatchSessionId(normalizedSessionId)
          ? 'ephemeral_dispatch_id_forbidden'
          : 'session_not_found_or_agent_scope_forbidden',
      });
      return;
    }
    this.agentSessionBindings.set(normalizedAgentId, normalizedSessionId);
    try {
      const provider = 'finger';
      const latest = this.sessionControlPlaneStore.list({ agentId: normalizedAgentId, provider })[0];
      const sameBinding = latest
        && latest.fingerSessionId === normalizedSessionId
        && latest.providerSessionId === normalizedSessionId;
      if (!sameBinding) {
        this.sessionControlPlaneStore.set(
          normalizedSessionId,
          normalizedAgentId,
          provider,
          normalizedSessionId,
          { source: 'runtime.bindAgentSession' },
        );
      }
    } catch (error) {
      log.warn('Failed to persist session control-plane binding', {
        agentId: normalizedAgentId,
        sessionId: normalizedSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Resolve the current preferred session binding for an agent.
   * Used by dispatch/session orchestration to keep agent runtime stable across turns/restarts.
   */
  getBoundSessionId(agentId: string): string | null {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) return null;
    const bound = this.sanitizeToolSessionCandidate(
      normalizedAgentId,
      this.agentSessionBindings.get(normalizedAgentId) ?? null,
      'runtime.getBoundSessionId.bound',
    );
    if (bound) return bound;
    const persisted = this.resolvePersistedAgentSessionBinding(normalizedAgentId);
    if (!persisted) return null;
    this.agentSessionBindings.set(normalizedAgentId, persisted);
    return persisted;
  }

  private async appendViewImageAttachmentEvent(sessionId: string, toolResult: unknown): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;

    const attachment = this.extractViewImageAttachment(toolResult);
    if (!attachment) return;

    const content = `[view_image] ${attachment.name}`;
    const message = await this.sessionManager.addMessage(sessionId, 'user', content, {
      attachments: [attachment],
    });
    if (!message) return;

    await this.eventBus.emit({
      type: 'user_message',
      sessionId,
      timestamp: message.timestamp,
      payload: {
        messageId: message.id,
        content,
        attachments: [attachment],
      },
    });
  }

  private extractViewImageAttachment(toolResult: unknown): Attachment | null {
    if (!isRecord(toolResult)) return null;
    if (toolResult.ok !== true) return null;
    if (typeof toolResult.path !== 'string' || toolResult.path.trim().length === 0) return null;
    if (typeof toolResult.mimeType !== 'string' || !toolResult.mimeType.startsWith('image/')) return null;

    const fullPath = toolResult.path.trim();
    const fileName = path.basename(fullPath);
    const attachment: Attachment = {
      id: `view-image-${Date.now()}`,
      name: fileName.length > 0 ? fileName : fullPath,
      type: 'image',
      url: fullPath,
      mimeType: typeof toolResult.mimeType === 'string' ? toolResult.mimeType : undefined,
    };
    if (typeof toolResult.sizeBytes === 'number' && Number.isFinite(toolResult.sizeBytes)) {
      attachment.size = Math.max(0, Math.floor(toolResult.sizeBytes));
    }
    return attachment;
  }

  /**
   * 注册工具
   */
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema: unknown;
    handler: (input: unknown, context?: Record<string, unknown>) => Promise<unknown>;
    policy?: 'allow' | 'deny';
  }): void {
    this.toolRegistry.register({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: tool.handler,
      policy: tool.policy || 'allow',
    });
  }

  /**
   * 设置工具策略
   */
  setToolPolicy(toolName: string, policy: 'allow' | 'deny'): boolean {
    return this.toolRegistry.setPolicy(toolName, policy);
  }

  /**
   * 列出工具
   */
  listTools(): Array<{ name: string; description: string; policy: 'allow' | 'deny' }> {
    return this.toolRegistry.list();
  }

  /**
   * 授予 agent 工具白名单权限
   */
  grantToolToAgent(agentId: string, toolName: string): AgentToolPolicy {
    return this.toolAccessControl.grant(agentId, toolName);
  }

  /**
   * 撤销 agent 工具白名单权限
   */
  revokeToolFromAgent(agentId: string, toolName: string): AgentToolPolicy {
    return this.toolAccessControl.revoke(agentId, toolName);
  }

  /**
   * 设置 agent 工具白名单
   */
  setAgentToolWhitelist(agentId: string, toolNames: string[]): AgentToolPolicy {
    return this.toolAccessControl.setWhitelist(agentId, toolNames);
  }

  /**
   * 设置 agent 工具黑名单
   */
  setAgentToolBlacklist(agentId: string, toolNames: string[]): AgentToolPolicy {
    return this.toolAccessControl.setBlacklist(agentId, toolNames);
  }

  /**
   * 将单个工具加入 agent 黑名单
   */
  denyToolForAgent(agentId: string, toolName: string): AgentToolPolicy {
    return this.toolAccessControl.deny(agentId, toolName);
  }

  /**
   * 从 agent 黑名单移除单个工具
   */
  allowToolForAgent(agentId: string, toolName: string): AgentToolPolicy {
    return this.toolAccessControl.allow(agentId, toolName);
  }

  /**
   * 获取 agent 工具权限策略
   */
  getAgentToolPolicy(agentId: string): AgentToolPolicy {
    return this.toolAccessControl.getPolicy(agentId);
  }

  /**
   * 清空 agent 工具权限策略
   */
  clearAgentToolPolicy(agentId: string): void {
    this.toolAccessControl.clear(agentId);
  }

  /**
   * 设置 agent 运行时配置（provider/session/governance）
   */
  setAgentRuntimeConfig(agentId: string, config: AgentRuntimeConfig): AgentRuntimeConfig {
    const normalized: AgentRuntimeConfig = {
      ...config,
      id: agentId,
    };
    this.agentRuntimeConfigs.set(agentId, normalized);
    return normalized;
  }

  /**
   * 读取 agent 运行时配置
   */
  getAgentRuntimeConfig(agentId: string): AgentRuntimeConfig | null {
    return this.agentRuntimeConfigs.get(agentId) ?? null;
  }

  /**
   * 清空 agent 运行时配置
   */
  clearAgentRuntimeConfig(agentId: string): void {
    this.agentRuntimeConfigs.delete(agentId);
  }

  /**
   * 列出所有 agent 运行时配置
   */
  listAgentRuntimeConfigs(): AgentRuntimeConfig[] {
    return Array.from(this.agentRuntimeConfigs.values())
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * 根据角色模板设置工具策略
   */
  applyAgentRoleToolPolicy(agentId: string, role: string): AgentToolPolicy {
    return applyRoleToolPolicy(this.toolAccessControl, agentId, role, this.roleToolPolicyPresets);
  }

  /**
   * 设置角色策略模板（由配置文件驱动）
   */
  setRoleToolPolicyPresets(presets: RoleToolPolicyPresetMap): string[] {
    const next: RoleToolPolicyPresetMap = {};
    for (const [key, preset] of Object.entries(presets)) {
      const roleKey = key.trim().toLowerCase();
      if (roleKey.length === 0) continue;
      next[roleKey] = {
        role: preset.role,
        whitelist: [...preset.whitelist],
        blacklist: [...preset.blacklist],
      };
    }
    this.roleToolPolicyPresets = next;
    return Object.keys(this.roleToolPolicyPresets).sort();
  }

  /**
   * 返回可用角色策略名称
   */
  listRoleToolPolicyPresets(): string[] {
    return Object.keys(this.roleToolPolicyPresets).sort();
  }

  /**
   * 设置工具是否需要授权令牌
   */
  setToolAuthorizationRequired(toolName: string, required: boolean): void {
    this.toolAuthorization.setToolRequired(toolName, required);
  }

  /**
   * 为 agent + tool 签发一次性/多次授权令牌
   */
  issueToolAuthorization(
    agentId: string,
    toolName: string,
    issuedBy: string,
    options: AuthorizationIssueOptions = {},
  ): ToolAuthorizationGrant {
    return this.toolAuthorization.issue(agentId, toolName, issuedBy, options);
  }

  /**
   * 吊销授权令牌
   */
  revokeToolAuthorization(token: string): boolean {
    return this.toolAuthorization.revoke(token);
  }

  // ==================== 任务进度 ====================

  /**
   * 报告任务开始
   */
  emitTaskStarted(sessionId: string, taskId: string, title: string, agentId?: string): void {
    this.eventBus.emit({
      type: 'task_started',
      sessionId,
      taskId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: { title },
    });
  }

  /**
   * 报告任务进度
   */
  emitTaskProgress(sessionId: string, taskId: string, progress: number, message?: string, agentId?: string): void {
    this.eventBus.emit({
      type: 'task_progress',
      sessionId,
      taskId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: { progress, message },
    });
  }

  /**
   * 报告任务完成
   */
  emitTaskCompleted(sessionId: string, taskId: string, result?: unknown, agentId?: string): void {
    this.eventBus.emit({
      type: 'task_completed',
      sessionId,
      taskId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: { result },
    });
  }

  /**
   * 报告任务失败
   */
  emitTaskFailed(sessionId: string, taskId: string, error: string, agentId?: string): void {
    this.eventBus.emit({
      type: 'task_failed',
      sessionId,
      taskId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: { error },
    });
  }

  // ==================== 工作流进度 ====================

  /**
   * 报告工作流进度
   */
  reportProgress(sessionId: string, progress: ProgressReport): void {
    this.eventBus.emit({
      type: 'workflow_progress',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        overallProgress: progress.overall,
        activeAgents: progress.activeAgents,
        pendingTasks: progress.pending,
        completedTasks: progress.completed,
        failedTasks: progress.failed,
      },
    });
  }

  /**
   * 报告 Plan 更新
   */
  emitPlanUpdated(sessionId: string, planId: string, version: number, taskCount: number, completedCount: number): void {
    this.eventBus.emit({
      type: 'plan_updated',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        planId,
        version,
        taskCount,
        completedCount,
      },
    });
  }

  // ==================== 上下文压缩 ====================

  /**
   * 压缩上下文
   */
  async compressContext(sessionId: string, options?: { trigger?: 'manual' | 'auto'; contextUsagePercent?: number }): Promise<string> {
    if (!this.sessionManager.compressContext) {
      throw new Error('Context compression not supported by session manager');
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const originalSize = session.messageCount ?? 0;
    const summarizer = createCompactionSummarizer({
      sessionId,
      trigger: options?.trigger,
      contextUsagePercent: options?.contextUsagePercent,
    });
    const summary = await this.sessionManager.compressContext(sessionId, summarizer);
    const compressedSize = summary.length;
    const nowIso = new Date().toISOString();

    const messages = this.sessionManager.getMessages(sessionId);
    const replacementHistory = buildCompactReplacementHistory(
      messages.map((message) => message as Record<string, unknown>),
    );
    const sessionContext = session.context ?? {};
    const ownerAgentId = typeof sessionContext.ownerAgentId === 'string' && sessionContext.ownerAgentId.trim().length > 0
      ? sessionContext.ownerAgentId.trim()
      : 'finger-project-agent';
    const mode = typeof sessionContext.sessionTier === 'string' && sessionContext.sessionTier.trim().length > 0
      ? sessionContext.sessionTier.trim()
      : 'main';
    const sourceEventIds = messages.map((message) => message.id);
    const sourceMessageIds = messages.map((message) => message.id);
    const sourceTimeStart = messages.length > 0 ? messages[0].timestamp : nowIso;
    const sourceTimeEnd = messages.length > 0 ? messages[messages.length - 1].timestamp : nowIso;

    let compactResult: Awaited<ReturnType<typeof executeContextLedgerMemory>> | undefined;
    try {
      compactResult = await executeContextLedgerMemory({
        action: 'compact',
        session_id: sessionId,
        agent_id: ownerAgentId,
        mode,
        trigger: options?.trigger === 'auto' ? 'auto' : 'manual',
        summary,
        source_event_ids: sourceEventIds,
        source_message_ids: sourceMessageIds,
        source_time_start: sourceTimeStart,
        source_time_end: sourceTimeEnd,
        source_slot_start: messages.length > 0 ? 1 : undefined,
        source_slot_end: messages.length > 0 ? messages.length : undefined,
        replacement_history: replacementHistory,
        _runtime_context: {
          session_id: sessionId,
          agent_id: ownerAgentId,
          mode,
        },
      });
    } catch (error) {
      // Keep session compression successful even if ledger compact persistence fails.
      log.warn('ledger compact persistence failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
    }

    if (replacementHistory.length > 0) {
      this.updateSessionContext(sessionId, {
        contextCompactReplacementHistory: replacementHistory,
        contextCompactReplacementUpdatedAt: new Date().toISOString(),
      });
    }

    this.eventBus.emit({
      type: 'session_compressed',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        originalSize,
        compressedSize,
        summary,
        trigger: options?.trigger === 'auto' ? 'auto' : 'manual',
        ...(typeof options?.contextUsagePercent === 'number' ? { contextUsagePercent: options.contextUsagePercent } : {}),
        ...(compactResult && compactResult.action === 'compact' ? {
          compactionId: compactResult.compaction_id,
          sourceTimeStart: compactResult.source_time_start,
          sourceTimeEnd: compactResult.source_time_end,
          sourceSlotStart: compactResult.source_slot_start,
          sourceSlotEnd: compactResult.source_slot_end,
        } : {}),
      },
    });

    return summary;
  }

  async maybeAutoCompact(sessionId: string, contextUsagePercent?: number, turnId?: string): Promise<boolean> {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) return false;
    if (typeof contextUsagePercent !== 'number' || !Number.isFinite(contextUsagePercent)) return false;

    const normalizedPercent = Math.max(0, Math.floor(contextUsagePercent));
    if (normalizedPercent < AUTO_CONTEXT_COMPACT_THRESHOLD_PERCENT) return false;

    const existing = autoCompactInFlightBySession.get(normalizedSessionId);
    if (existing) return existing;

    const compactJob = (async () => {
      const now = Date.now();
      const state = autoCompactStateBySession.get(normalizedSessionId);
      const normalizedTurnId = typeof turnId === 'string' && turnId.trim().length > 0
        ? turnId.trim()
        : undefined;
      if (state) {
        if (normalizedTurnId && state.lastTurnId === normalizedTurnId) return false;
        if (now - state.lastAttemptAt < AUTO_CONTEXT_COMPACT_COOLDOWN_MS) return false;
      }

      autoCompactStateBySession.set(normalizedSessionId, {
        lastAttemptAt: now,
        ...(normalizedTurnId ? { lastTurnId: normalizedTurnId } : {}),
      });

      try {
        await this.compressContext(normalizedSessionId, {
          trigger: 'auto',
          contextUsagePercent: normalizedPercent,
        });
        log.info('Auto context compact triggered', {
          sessionId: normalizedSessionId,
          contextUsagePercent: normalizedPercent,
          thresholdPercent: AUTO_CONTEXT_COMPACT_THRESHOLD_PERCENT,
          turnId: normalizedTurnId,
        });
        return true;
      } catch (error) {
        log.warn('Auto context compact failed', {
          sessionId: normalizedSessionId,
          contextUsagePercent: normalizedPercent,
          turnId: normalizedTurnId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    })();

    autoCompactInFlightBySession.set(normalizedSessionId, compactJob);
    try {
      return await compactJob;
    } finally {
      autoCompactInFlightBySession.delete(normalizedSessionId);
    }
  }

  async maybeAutoDigestOnStop(sessionId: string, turnId?: string): Promise<boolean> {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) return false;
    const existing = autoDigestStopInFlightBySession.get(normalizedSessionId);
    if (existing) return existing;

    const digestJob = (async () => {
      const now = Date.now();
      const normalizedTurnId = typeof turnId === 'string' && turnId.trim().length > 0
        ? turnId.trim()
        : undefined;
      const state = autoDigestStopStateBySession.get(normalizedSessionId);
      if (state && normalizedTurnId && state.lastTurnId === normalizedTurnId) return false;
      autoDigestStopStateBySession.set(normalizedSessionId, {
        lastAttemptAt: now,
        ...(normalizedTurnId ? { lastTurnId: normalizedTurnId } : {}),
      });

      const session = this.sessionManager.getSession(normalizedSessionId);
      if (!session) return false;
      const sessionContext = session.context ?? {};
      const ownerAgentId = typeof sessionContext.ownerAgentId === 'string' && sessionContext.ownerAgentId.trim().length > 0
        ? sessionContext.ownerAgentId.trim()
        : 'finger-project-agent';
      const mode = typeof sessionContext.sessionTier === 'string' && sessionContext.sessionTier.trim().length > 0
        ? sessionContext.sessionTier.trim()
        : 'main';

      try {
        const digestResult = await executeContextLedgerMemory({
          action: 'digest_incremental',
          session_id: normalizedSessionId,
          agent_id: ownerAgentId,
          mode,
          trigger: 'auto',
          _runtime_context: {
            session_id: normalizedSessionId,
            agent_id: ownerAgentId,
            mode,
          },
        });
        if (digestResult.action !== 'digest_incremental') return false;
        if (digestResult.no_new_entries === true || digestResult.task_digest_count <= 0) {
          log.info('Auto stop digest skipped (no new entries)', {
            sessionId: normalizedSessionId,
            turnId: normalizedTurnId,
            sourceSlotStart: digestResult.source_slot_start,
            sourceSlotEnd: digestResult.source_slot_end,
            previousCompactedSlotEnd: digestResult.previous_compacted_slot_end,
          });
          return false;
        }
        this.updateSessionContext(normalizedSessionId, {
          contextDigestLastSourceSlotStart: digestResult.source_slot_start,
          contextDigestLastSourceSlotEnd: digestResult.source_slot_end,
          contextDigestLastUpdatedAt: new Date().toISOString(),
        });
        log.info('Auto stop digest completed', {
          sessionId: normalizedSessionId,
          turnId: normalizedTurnId,
          taskDigestCount: digestResult.task_digest_count,
          sourceSlotStart: digestResult.source_slot_start,
          sourceSlotEnd: digestResult.source_slot_end,
          previousCompactedSlotEnd: digestResult.previous_compacted_slot_end,
        });
        return true;
      } catch (error) {
        log.warn('Auto stop digest failed', {
          sessionId: normalizedSessionId,
          turnId: normalizedTurnId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    })();

    autoDigestStopInFlightBySession.set(normalizedSessionId, digestJob);
    try {
      return await digestJob;
    } finally {
      autoDigestStopInFlightBySession.delete(normalizedSessionId);
    }
  }

  // ==================== 事件订阅 ====================

  /**
   * 订阅事件
   */
  subscribe(eventType: string, handler: (event: RuntimeEvent) => void): () => void {
    return this.eventBus.subscribe(eventType, handler);
  }

  /**
   * 获取事件历史
   */
  getEventHistory(sessionId?: string, limit?: number): RuntimeEvent[] {
    if (sessionId) {
      return this.eventBus.getSessionHistory(sessionId, limit);
    }
    return this.eventBus.getHistory(limit);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
