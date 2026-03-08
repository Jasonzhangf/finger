import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import './ChatInterface.css';
import type {
  ReviewSettings,
  ReviewStrictness,
  RuntimeEvent,
  RuntimeFile,
  RuntimeImage,
  UserInputPayload,
  WorkflowExecutionState,
} from '../../api/types.js';
import {
  getSlashCommandDefinition,
  listImplementedSlashCommands,
  parseSlashCommandInput,
} from './slashCommands.js';

export interface InputCapability {
  acceptText: boolean;
  acceptImages: boolean;
  acceptFiles: boolean;
  acceptedFileMimePrefixes?: string[];
}

interface AgentRunStatus {
  phase: 'idle' | 'running' | 'dispatching' | 'error';
  text: string;
  updatedAt: string;
}

interface RuntimeOverview {
  reqTokens?: number;
  respTokens?: number;
  totalTokens?: number;
  tokenUpdatedAtLocal?: string;
  contextUsagePercent?: number;
  contextTokensInWindow?: number;
  contextMaxInputTokens?: number;
  contextThresholdPercent?: number;
  ledgerFocusMaxChars: number;
  lastLedgerInsertChars?: number;
  compactCount: number;
  updatedAt: string;
  workingProjectPath?: string;
  sourceProjectPath?: string;
  sessionPath?: string;
}

interface ToolPanelOverview {
  availableTools: string[];
  exposedTools: string[];
}

interface InputLockState {
  sessionId: string;
  lockedBy: string | null;
  lockedAt: string | null;
  typing: boolean;
}

interface DebugSnapshotItem {
  id: string;
  timestamp: string;
  stage: string;
  summary: string;
  requestId?: string;
  attempt?: number;
  phase?: string;
}

interface OrchestratorRuntimeModeState {
  mode: string;
  fsmV2Implemented: boolean;
  runnerModuleId?: string;
}

interface RequestDetailsSnapshot {
  target?: string;
  agentId?: string;
  roleProfile?: string;
  input?: unknown;
  tools?: unknown;
  contextLedger?: unknown;
}

interface DryrunSnapshotSummary {
  target?: string;
  agentId?: string;
  roleProfile?: string;
  tools?: unknown;
  developerInstructions?: string;
  injectedPrompt?: string;
  contextLedger?: unknown;
  turnContext?: unknown;
  environmentContext?: string;
  userInstructions?: string;
}

interface ChatInterfaceProps {
  executionState: WorkflowExecutionState | null;
  agents: Array<{ id: string; name: string; status: string }>;
  events: RuntimeEvent[];
  contextEditableEventIds?: string[];
  agentRunStatus?: AgentRunStatus;
  panelTitle?: string;
  showRuntimeModeBadge?: boolean;
  runtimeOverview?: RuntimeOverview;
  contextLabel?: string;
  toolPanelOverview?: ToolPanelOverview;
  onUpdateToolExposure?: (tools: string[]) => Promise<boolean> | boolean;
  onSendMessage: (payload: UserInputPayload) => Promise<void> | void;
  onEditMessage?: (eventId: string, content: string) => Promise<boolean>;
  onDeleteMessage?: (eventId: string) => Promise<boolean>;
  onCreateNewSession?: () => Promise<void> | void;
  onPause: () => void;
  onResume: () => void;
  onInterruptTurn?: () => Promise<boolean> | boolean;
  isPaused: boolean;
  isConnected: boolean;
  onAgentClick?: (agentId: string) => void;
  selectedAgentId?: string | null;
  eventFilterAgentId?: string | null;
  inputCapability?: InputCapability;
  inputLockState?: InputLockState | null;
  clientId?: string | null;
  onAcquireInputLock?: () => Promise<boolean>;
  onReleaseInputLock?: () => void;
  debugSnapshotsEnabled?: boolean;
  onToggleDebugSnapshots?: (enabled: boolean) => void;
  debugSnapshots?: DebugSnapshotItem[];
  onClearDebugSnapshots?: () => void;
  orchestratorRuntimeMode?: OrchestratorRuntimeModeState | null;
  onToggleRequestDetails?: (enabled: boolean) => void;
  requestDetailsEnabled?: boolean;
  interruptTargetLabel?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  eventId: string;
}

interface DecoratedEvent extends RuntimeEvent {
  key: string;
  eventId: string;
}

const CONTEXT_MENU_WIDTH = 220;
const CONTEXT_MENU_HEIGHT = 240;
const MESSAGE_PAGE_SIZE = 40;
const DEFAULT_INPUT_CAPABILITY: InputCapability = {
  acceptText: true,
  acceptImages: true,
  acceptFiles: true,
};

const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  enabled: false,
  target: '',
  strictness: 'mainline',
  maxTurns: 10,
};

interface WebkitFileSystemEntry {
  isDirectory: boolean;
  isFile: boolean;
  name: string;
  fullPath?: string;
}

function formatOrchestratorPhase(phase: string | undefined): string | null {
  if (!phase) return null;
  const normalized = phase.trim();
  if (normalized.length === 0) return null;
  return normalized.replace(/_/g, ' ');
}

function createRuntimeId(file: File): string {
  return `${Date.now()}-${file.name}-${Math.random().toString(36).slice(2, 8)}`;
}

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('FileReader returned non-string data url'));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('FileReader failed'));
    };
    reader.readAsDataURL(file);
  });
}

function shouldInlineText(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type.startsWith('text/')) return true;

  const name = file.name.toLowerCase();
  return (
    name.endsWith('.md') ||
    name.endsWith('.txt') ||
    name.endsWith('.json') ||
    name.endsWith('.yaml') ||
    name.endsWith('.yml') ||
    name.endsWith('.ts') ||
    name.endsWith('.tsx') ||
    name.endsWith('.js') ||
    name.endsWith('.jsx') ||
    name.endsWith('.rs') ||
    name.endsWith('.py') ||
    name.endsWith('.go') ||
    name.endsWith('.java') ||
    name.endsWith('.sh')
  );
}

async function createPreviewFiles(files: File[] | FileList | null): Promise<RuntimeFile[]> {
  if (!files) return [];
  const source = Array.isArray(files) ? files : Array.from(files);
  if (source.length === 0) return [];

  const all = await Promise.all(
    source.map(async (file) => {
      let textContent: string | undefined;
      if (shouldInlineText(file)) {
        try {
          textContent = await file.text();
        } catch {
          textContent = undefined;
        }
      }

      return {
        id: createRuntimeId(file),
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        dataUrl: await toDataUrl(file),
        textContent,
      };
    }),
  );
  return all;
}

function mergeDraftText(current: string, incoming: string): string {
  const lhs = current.trim();
  const rhs = incoming.trim();
  if (!lhs) return rhs;
  if (!rhs) return lhs;
  return `${lhs}\n${rhs}`;
}

function mergeImages(current: RuntimeImage[], incoming: RuntimeImage[]): RuntimeImage[] {
  const map = new Map<string, RuntimeImage>();
  for (const item of current) {
    map.set(item.id, item);
  }
  for (const item of incoming) {
    const key = item.id || `${item.name}:${item.url}`;
    if (!map.has(key)) {
      map.set(key, { ...item, id: key });
    }
  }
  return Array.from(map.values());
}

function mergeFiles(current: RuntimeFile[], incoming: RuntimeFile[]): RuntimeFile[] {
  const map = new Map<string, RuntimeFile>();
  for (const item of current) {
    map.set(item.id, item);
  }
  for (const item of incoming) {
    const key = item.id || `${item.name}:${item.dataUrl ?? ''}`;
    if (!map.has(key)) {
      map.set(key, { ...item, id: key });
    }
  }
  return Array.from(map.values());
}

function formatTokenUsage(event: RuntimeEvent): string {
  const usage = event.tokenUsage;
  if (!usage) return 'Token: N/A';
  const total = typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined;
  const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined;
  const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined;
  const parts: string[] = [];
  if (typeof total === 'number') parts.push(`总计 ${total}`);
  if (typeof input === 'number') parts.push(`输入 ${input}`);
  if (typeof output === 'number') parts.push(`输出 ${output}`);
  if (parts.length === 0) return 'Token: N/A';
  return `${usage.estimated ? 'Token(估算):' : 'Token:'} ${parts.join(' · ')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatToolInput(toolInput: unknown): string | null {
  if (toolInput === undefined || toolInput === null) return null;
  if (typeof toolInput === 'string') return toolInput.trim().length > 0 ? toolInput : null;
  try {
    const encoded = JSON.stringify(toolInput, null, 2);
    return encoded.length > 0 ? encoded : null;
  } catch {
    return null;
  }
}

function unwrapToolInput(toolInput: unknown): unknown {
  if (!isRecord(toolInput)) return toolInput;
  if (isRecord(toolInput.input)) return toolInput.input;
  if (isRecord(toolInput.args)) return toolInput.args;
  return toolInput;
}

function toolChipLabel(event: RuntimeEvent): string {
  if (event.kind === 'action') return '执行中';
  if (event.toolStatus === 'error') return '执行失败';
  if (event.toolStatus === 'success') return '执行成功';
  return '工具结果';
}

function toolCategoryClass(category?: RuntimeEvent['toolCategory']): string {
  if (category === '读取') return 'category-read';
  if (category === '写入' || category === '编辑') return 'category-write';
  if (category === '搜索' || category === '网络搜索') return 'category-search';
  if (category === '计划') return 'category-plan';
  return 'category-other';
}

function formatToolOutputForDisplay(event: RuntimeEvent): string | null {
  if (event.toolStatus === 'error' && typeof event.errorMessage === 'string' && event.errorMessage.trim().length > 0) {
    return event.errorMessage.trim();
  }
  return formatToolInput(event.toolOutput);
}

function formatJsonBlock(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function buildToolOutputPreview(output: string, maxChars = 120): string {
  const normalized = output.replace(/\s+/g, ' ').trim();
  if (!normalized) return '无可展示输出';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function formatCommandArray(parts: unknown[]): string {
  return parts
    .filter((part): part is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof part))
    .map((part) => String(part))
    .join(' ')
    .trim();
}

function extractToolCommand(toolInput: unknown): string | null {
  const normalizedInput = unwrapToolInput(toolInput);
  if (!isRecord(normalizedInput)) return null;
  const cmd = typeof normalizedInput.cmd === 'string' ? normalizedInput.cmd.trim() : '';
  if (cmd.length > 0) return cmd;
  const command = normalizedInput.command;
  if (typeof command === 'string' && command.trim().length > 0) return command.trim();
  if (Array.isArray(command)) {
    const text = formatCommandArray(command);
    if (text.length > 0) return text;
  }
  return null;
}

function buildToolChipName(event: RuntimeEvent): string {
  const toolName = event.toolName ?? 'unknown';
  const command = extractToolCommand(event.toolInput);
  const category = event.toolCategory ? `[${event.toolCategory}] ` : '';
  if (!command) return `${category}${toolName}`;
  const compact = command.replace(/\s+/g, ' ').trim();
  if (compact.length <= 80) return `${category}${toolName} · ${compact}`;
  return `${category}${toolName} · ${compact.slice(0, 80)}...`;
}

function buildToolInputSummary(event: RuntimeEvent): string | null {
  const toolInput = unwrapToolInput(event.toolInput);
  if (toolInput === undefined || toolInput === null) return null;
  if (typeof toolInput === 'string') {
    const text = toolInput.trim();
    if (text.length === 0) return null;
    return text.length <= 180 ? `参数：${text}` : `参数：${text.slice(0, 180)}...`;
  }
  if (!isRecord(toolInput)) return null;

  const cmd = typeof toolInput.cmd === 'string' ? toolInput.cmd.trim() : '';
  if (cmd.length > 0) return `参数：cmd = ${cmd}`;

  const command = toolInput.command;
  if (typeof command === 'string' && command.trim().length > 0) {
    return `参数：command = ${command.trim()}`;
  }
  if (Array.isArray(command)) {
    const commandText = formatCommandArray(command);
    if (commandText.length > 0) return `参数：command = ${commandText}`;
  }

  const action = typeof toolInput.action === 'string' ? toolInput.action.trim() : '';
  if (action.length > 0) return `参数：action = ${action}`;
  const path = typeof toolInput.path === 'string' ? toolInput.path.trim() : '';
  if (path.length > 0) return `参数：path = ${path}`;
  const query = typeof toolInput.query === 'string' ? toolInput.query.trim() : '';
  if (query.length > 0) return `参数：query = ${query}`;
  return null;
}

function shouldShowFullToolInput(event: RuntimeEvent): boolean {
  const toolInput = unwrapToolInput(event.toolInput);
  if (!isRecord(toolInput)) return true;
  const toolName = (event.toolName ?? '').trim();
  const keys = Object.keys(toolInput);
  const simpleExecKeys = new Set(['cmd', 'login', 'max_output_tokens', 'shell', 'yield_time_ms']);
  const cmd = typeof toolInput.cmd === 'string' ? toolInput.cmd.trim() : '';
  const simpleExecCall = (
    toolName === 'exec_command'
    || toolName === 'shell.exec'
    || toolName === 'shell'
    || toolName === 'shell_command'
  )
    && cmd.length > 0
    && cmd.length <= 120
    && keys.length > 0
    && keys.every((key) => simpleExecKeys.has(key));
  return !simpleExecCall;
}

function inferToolCategoryFromName(toolName: string): string {
  if (toolName === 'apply_patch') return '编辑';
  if (toolName === 'update_plan') return '计划';
  if (toolName === 'web_search') return '网络搜索';
  if (toolName === 'context_ledger.memory') return '搜索';
  if (toolName === 'view_image') return '读取';
  if (toolName === 'write_stdin') return '写入';
  if (toolName === 'exec_command' || toolName === 'shell.exec') return '其他';
  return '其他';
}

function buildToolDashboard(
  events: RuntimeEvent[],
  availableTools: string[] = [],
  exposedTools: string[] = [],
): {
  total: number;
  success: number;
  failed: number;
  tools: Array<{
    name: string;
    category: string;
    total: number;
    success: number;
    failed: number;
    exposed: boolean;
    available: boolean;
    lastAt?: string;
  }>;
} {
  const map = new Map<string, {
    name: string;
    category: string;
    total: number;
    success: number;
    failed: number;
    exposed: boolean;
    available: boolean;
    lastAt?: string;
  }>();
  const availableSet = new Set(availableTools.map((item) => item.trim()).filter((item) => item.length > 0));
  const exposedSet = new Set(exposedTools.map((item) => item.trim()).filter((item) => item.length > 0));
  let total = 0;
  let success = 0;
  let failed = 0;

  for (const toolName of availableSet) {
    map.set(toolName, {
      name: toolName,
      category: inferToolCategoryFromName(toolName),
      total: 0,
      success: 0,
      failed: 0,
      exposed: exposedSet.has(toolName),
      available: true,
    });
  }

  for (const event of events) {
    if (!event.toolName) continue;
    if (event.kind !== 'observation') continue;
    if (event.toolStatus !== 'success' && event.toolStatus !== 'error') continue;
    total += 1;
    if (event.toolStatus === 'success') success += 1;
    if (event.toolStatus === 'error') failed += 1;

    const key = event.toolName;
    const current = map.get(key) ?? {
      name: event.toolName,
      category: event.toolCategory ?? inferToolCategoryFromName(event.toolName),
      total: 0,
      success: 0,
      failed: 0,
      exposed: exposedSet.has(event.toolName),
      available: availableSet.has(event.toolName),
    };
    current.total += 1;
    if (event.toolStatus === 'success') current.success += 1;
    if (event.toolStatus === 'error') current.failed += 1;
    current.category = event.toolCategory ?? current.category;
    current.exposed = current.exposed || exposedSet.has(event.toolName);
    current.available = current.available || availableSet.has(event.toolName);
    current.lastAt = event.timestamp;
    map.set(key, current);
  }

  const tools = Array.from(map.values()).sort((a, b) => {
    const exposedWeight = Number(b.exposed) - Number(a.exposed);
    if (exposedWeight !== 0) return exposedWeight;
    const totalWeight = b.total - a.total;
    if (totalWeight !== 0) return totalWeight;
    return a.name.localeCompare(b.name);
  });
  return { total, success, failed, tools };
}

function formatRuntimeOverview(overview?: RuntimeOverview): string {
  if (!overview) return '上下文: N/A · Ledger: N/A';
  const derivedUsagePercent = (
    typeof overview.contextTokensInWindow === 'number'
    && typeof overview.contextMaxInputTokens === 'number'
    && overview.contextMaxInputTokens > 0
  )
    ? Math.max(0, Math.min(100, Math.floor((overview.contextTokensInWindow / overview.contextMaxInputTokens) * 100)))
    : undefined;
  const contextUsagePercent = typeof overview.contextUsagePercent === 'number'
    ? overview.contextUsagePercent
    : derivedUsagePercent;
  const contextText = typeof contextUsagePercent === 'number'
    ? (typeof overview.contextTokensInWindow === 'number' && typeof overview.contextMaxInputTokens === 'number'
      ? `上下文 ${contextUsagePercent}% (${overview.contextTokensInWindow}/${overview.contextMaxInputTokens})`
      : `上下文 ${contextUsagePercent}%`)
    : (typeof overview.contextTokensInWindow === 'number'
      ? `上下文 ${overview.contextTokensInWindow} tokens`
      : '上下文 N/A');
  const thresholdText = typeof overview.contextThresholdPercent === 'number'
    ? `阈值 ${overview.contextThresholdPercent}%`
    : '阈值 N/A';
  const ledgerText = `Ledger ${overview.lastLedgerInsertChars ? `最近插入 ${overview.lastLedgerInsertChars} 字符` : '无最近插入'} · 焦点上限 ${overview.ledgerFocusMaxChars}`;
  const compactText = `压缩 ${overview.compactCount}`;
  return `${contextText} · ${thresholdText} · ${ledgerText} · ${compactText}`;
}

function formatRuntimePaths(overview?: RuntimeOverview): string {
  if (!overview) return '';
  const parts: string[] = [];
  if (overview.workingProjectPath) parts.push(`Working: ${overview.workingProjectPath}`);
  if (overview.sourceProjectPath) parts.push(`Source: ${overview.sourceProjectPath}`);
  if (overview.sessionPath) parts.push(`Session: ${overview.sessionPath}`);
  return parts.join(' · ');
}

function formatRuntimeTokenSummary(overview?: RuntimeOverview): string {
  if (!overview) return 'Token: N/A';
  const parts: string[] = [];
  if (typeof overview.totalTokens === 'number') parts.push(`总计 ${overview.totalTokens}`);
  if (typeof overview.reqTokens === 'number') parts.push(`输入 ${overview.reqTokens}`);
  if (typeof overview.respTokens === 'number') parts.push(`输出 ${overview.respTokens}`);
  if (parts.length === 0) return 'Token: N/A';
  const ts = overview.tokenUpdatedAtLocal ? ` @ ${overview.tokenUpdatedAtLocal}` : '';
  return `Token: ${parts.join(' · ')}${ts}`;
}

function capabilityAllowsFile(file: RuntimeFile, capability: InputCapability): boolean {
  if (!capability.acceptFiles) return false;
  const prefixes = capability.acceptedFileMimePrefixes;
  if (!prefixes || prefixes.length === 0) return true;
  return prefixes.some((prefix) => file.mimeType.startsWith(prefix));
}

function buildImageFromFile(file: RuntimeFile): RuntimeImage | null {
  if (!file.mimeType.startsWith('image/')) return null;
  if (typeof file.dataUrl !== 'string' || file.dataUrl.trim().length === 0) return null;
  return {
    id: file.id,
    name: file.name,
    url: file.dataUrl,
    dataUrl: file.dataUrl,
    mimeType: file.mimeType,
    size: file.size,
  };
}

function sanitizeDraftByCapability(
  draft: UserInputPayload,
  capability: InputCapability,
): { payload: UserInputPayload; dropped: number; reason?: string } {
  const text = draft.text.trim();
  const images = (draft.images ?? []).filter((image) => capability.acceptImages && image.url.length > 0);
  const files = (draft.files ?? []).filter((file) => capabilityAllowsFile(file, capability));

  const dropped =
    (draft.images?.length ?? 0) - images.length +
    (draft.files?.length ?? 0) - files.length;

  if (text.length === 0 && images.length === 0 && files.length === 0) {
    return {
      payload: { text: '', images: [], files: [] },
      dropped,
      reason: '当前输入内容不被目标 Agent 支持',
    };
  }

  return {
    payload: {
      text,
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { files } : {}),
    },
    dropped,
  };
}

async function copyImageToClipboard(image?: RuntimeImage): Promise<boolean> {
  if (!image) return false;

  try {
    const response = await fetch(image.url);
    const blob = await response.blob();

    if (
      typeof window.ClipboardItem !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.write === 'function'
    ) {
      const mimeType = blob.type || 'image/png';
      await navigator.clipboard.write([new window.ClipboardItem({ [mimeType]: blob })]);
      return true;
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(image.url);
      return true;
    }
  } catch {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(image.url);
        return true;
      } catch {
        return false;
      }
    }
  }

  return false;
}

function planStepStatusLabel(status: 'pending' | 'in_progress' | 'completed'): string {
  if (status === 'completed') return '已完成';
  if (status === 'in_progress') return '进行中';
  return '待处理';
}

function planStepStatusIcon(status: 'pending' | 'in_progress' | 'completed'): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '●';
  return '○';
}

const MessageItem = React.memo<{
  event: RuntimeEvent;
  agentStatus?: string;
  onAgentClick?: (agentId: string) => void;
  onRetry?: (event: RuntimeEvent) => void;
  onImageDoubleClick?: (image: RuntimeImage) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>, event: RuntimeEvent) => void;
}>(({ event, agentStatus, onAgentClick, onRetry, onImageDoubleClick, onContextMenu }) => {
  const isUser = event.role === 'user';
  const isAgent = event.role === 'agent';
  const isSystem = event.role === 'system';

  const isPending = event.agentId === 'pending';
  const isConfirmed = event.agentId === 'confirmed';
  const isError = event.agentId === 'error';

  const getMessageStatus = (): string | undefined => {
    if (isPending) return 'pending';
    if (isConfirmed) return 'confirmed';
    if (isError) return 'error';
    if (agentStatus) return agentStatus;
    return undefined;
  };

  const messageStatus = getMessageStatus();

  const dryrunSnapshot: DryrunSnapshotSummary | null = isRecord(event.metadata) && isRecord(event.metadata.dryrunSnapshot)
    ? event.metadata.dryrunSnapshot as DryrunSnapshotSummary
    : null;
  const dryrunTarget = dryrunSnapshot && typeof dryrunSnapshot.target === 'string'
    ? dryrunSnapshot.target
    : event.agentId;
  const dryrunAgentId = dryrunSnapshot && typeof dryrunSnapshot.agentId === 'string'
    ? dryrunSnapshot.agentId
    : event.agentId;
  const dryrunRole = dryrunSnapshot && typeof dryrunSnapshot.roleProfile === 'string'
    ? dryrunSnapshot.roleProfile
    : '';
  const dryrunTools = dryrunSnapshot && isRecord(dryrunSnapshot.tools) ? dryrunSnapshot.tools : null;
  const dryrunToolList = Array.isArray(dryrunTools?.requested)
    ? dryrunTools.requested
      .map((item) => (isRecord(item) && typeof item.name === 'string' ? item.name : ''))
      .filter((name) => name.length > 0)
    : [];
  const dryrunDeveloper = dryrunSnapshot && typeof dryrunSnapshot.developerInstructions === 'string'
    ? dryrunSnapshot.developerInstructions
    : null;
  const dryrunInjected = dryrunSnapshot && typeof dryrunSnapshot.injectedPrompt === 'string'
    ? dryrunSnapshot.injectedPrompt
    : null;
  const dryrunContextLedger = dryrunSnapshot && isRecord(dryrunSnapshot.contextLedger)
    ? dryrunSnapshot.contextLedger
    : null;
  const dryrunTurnContext = dryrunSnapshot && isRecord(dryrunSnapshot.turnContext)
    ? dryrunSnapshot.turnContext
    : null;
  const dryrunEnvironmentContext = dryrunSnapshot && typeof dryrunSnapshot.environmentContext === 'string'
    ? dryrunSnapshot.environmentContext
    : null;
 const dryrunUserInstructions = dryrunSnapshot && typeof dryrunSnapshot.userInstructions === 'string'
   ? dryrunSnapshot.userInstructions
   : null;

  const requestDetailsSnapshot: RequestDetailsSnapshot | null = isRecord(event.metadata) && isRecord(event.metadata.requestDetails)
    ? event.metadata.requestDetails as RequestDetailsSnapshot
    : null;

  const handleAgentClick = useCallback(() => {
    if (event.agentId && onAgentClick && (isAgent || (isSystem && event.agentId))) {
      onAgentClick(event.agentId);
    }
  }, [event.agentId, onAgentClick, isAgent, isSystem]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!onContextMenu) return;
      onContextMenu(e, event);
    },
    [event, onContextMenu],
  );

  return (
    <div
      className={`message ${isUser ? 'user' : isAgent ? 'agent' : 'system'} ${messageStatus || ''}`}
      onContextMenu={handleContextMenu}
    >
      <div className="message-avatar">
        {isPending ? '⏳' : isError ? '❌' : isUser ? '👤' : isAgent ? '🤖' : 'ℹ️'}
      </div>
      <div className="message-content-wrapper">
        <div className="message-header">
          {isAgent && event.agentId && (
            <>
              <button
                type="button"
                className="agent-name-btn"
                onClick={handleAgentClick}
              >
                {event.agentName || event.agentId}
              </button>
              {agentStatus && (
                <span className={`agent-status-badge ${agentStatus}`}>
                  {agentStatus}
                </span>
              )}
            </>
          )}
          {isUser && <span className="sender-label">You</span>}
          {isUser && isPending && <span className="status-indicator pending">发送中...</span>}
          {isUser && isConfirmed && <span className="status-indicator confirmed">已发送</span>}
          {isUser && isError && <span className="status-indicator error">发送失败</span>}
          {isSystem && event.agentId && (
            <button
              type="button"
              className="agent-name-btn"
              onClick={handleAgentClick}
            >
              {event.agentName || event.agentId}
            </button>
          )}
          {isSystem && !event.agentId && <span className="sender-label">System</span>}
          <span className="message-time">{new Date(event.timestamp).toLocaleString()}</span>
        </div>

        <div className="message-body">
         {dryrunSnapshot && (
           <div className="dryrun-chip">Dryrun</div>
         )}
          {requestDetailsSnapshot && (
            <div className="request-details-chip">Request Details</div>
          )}
         {event.toolName && (
            <div className={`tool-event-chip ${event.kind || 'status'} ${event.toolStatus || ''} ${toolCategoryClass(event.toolCategory)}`}>
              <span className="tool-event-label">{toolChipLabel(event)}</span>
              <span className="tool-event-name">{buildToolChipName(event)}</span>
              {typeof event.toolDurationMs === 'number' && (
                <span className="tool-event-duration">{event.toolDurationMs}ms</span>
              )}
            </div>
          )}
          <div className="message-text">{event.content}</div>
          {dryrunSnapshot && (
            <details className="dryrun-details">
              <summary>
                查看 Dryrun 详情
                {dryrunTarget ? ` · ${dryrunTarget}` : ''}
                {dryrunAgentId && dryrunAgentId !== dryrunTarget ? ` · ${dryrunAgentId}` : ''}
                {dryrunRole ? ` · ${dryrunRole}` : ''}
              </summary>
              {dryrunAgentId && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Agent ID</div>
                  <pre className="dryrun-code">{dryrunAgentId}</pre>
                </div>
              )}
              {dryrunRole && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Role Profile</div>
                  <pre className="dryrun-code">{dryrunRole}</pre>
                </div>
              )}
              {dryrunToolList.length > 0 && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Tools</div>
                  <div className="dryrun-list">{dryrunToolList.join(', ')}</div>
                </div>
              )}
              {dryrunDeveloper && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Developer Instructions</div>
                  <pre className="dryrun-code">{dryrunDeveloper}</pre>
                </div>
              )}
              {dryrunInjected && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Injected Prompt</div>
                  <pre className="dryrun-code">{dryrunInjected}</pre>
                </div>
              )}
              {dryrunUserInstructions && (
                <div className="dryrun-block">
                  <div className="dryrun-label">User Instructions</div>
                  <pre className="dryrun-code">{dryrunUserInstructions}</pre>
                </div>
              )}
              {dryrunEnvironmentContext && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Environment Context</div>
                  <pre className="dryrun-code">{dryrunEnvironmentContext}</pre>
                </div>
              )}
              {dryrunTurnContext && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Turn Context</div>
                  <pre className="dryrun-code">{formatJsonBlock(dryrunTurnContext)}</pre>
                </div>
              )}
              {dryrunContextLedger && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Context Ledger</div>
                  <pre className="dryrun-code">{formatJsonBlock(dryrunContextLedger)}</pre>
                </div>
              )}
              {dryrunTools && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Tool Schemas</div>
                  <pre className="dryrun-code">{formatJsonBlock(dryrunTools)}</pre>
                </div>
              )}
             <div className="dryrun-block">
               <div className="dryrun-label">Raw Snapshot</div>
               <pre className="dryrun-code">{formatJsonBlock(dryrunSnapshot)}</pre>
             </div>
           </details>
         )}
          {requestDetailsSnapshot && (
            <details className="dryrun-details">
              <summary>查看请求详情</summary>
              {typeof requestDetailsSnapshot.agentId === 'string' && requestDetailsSnapshot.agentId.length > 0 && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Agent ID</div>
                  <pre className="dryrun-code">{String(requestDetailsSnapshot.agentId)}</pre>
                </div>
              )}
              {typeof requestDetailsSnapshot.target === 'string' && requestDetailsSnapshot.target.length > 0 && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Target</div>
                  <pre className="dryrun-code">{String(requestDetailsSnapshot.target)}</pre>
                </div>
              )}
              {typeof requestDetailsSnapshot.roleProfile === 'string' && requestDetailsSnapshot.roleProfile.length > 0 && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Role Profile</div>
                  <pre className="dryrun-code">{String(requestDetailsSnapshot.roleProfile)}</pre>
                </div>
              )}
              {requestDetailsSnapshot.input != null && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Input</div>
                  <pre className="dryrun-code">{formatJsonBlock(requestDetailsSnapshot.input as Record<string,unknown>)}</pre>
                </div>
              )}
              {requestDetailsSnapshot.tools != null && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Tools</div>
                  <pre className="dryrun-code">{formatJsonBlock(requestDetailsSnapshot.tools as Record<string,unknown>)}</pre>
                </div>
              )}
              {requestDetailsSnapshot.contextLedger != null && (
                <div className="dryrun-block">
                  <div className="dryrun-label">Context Ledger</div>
                  <pre className="dryrun-code">{formatJsonBlock(requestDetailsSnapshot.contextLedger as Record<string,unknown>)}</pre>
                </div>
              )}
              <div className="dryrun-block">
                <div className="dryrun-label">Raw Request</div>
                <pre className="dryrun-code">{formatJsonBlock(requestDetailsSnapshot)}</pre>
              </div>
            </details>
          )}
         {event.kind === 'action' && event.toolName && (() => {
            const toolInputSummary = buildToolInputSummary(event);
            const toolInput = formatToolInput(event.toolInput);
            if (!toolInput && !toolInputSummary) return null;
            const showFullInput = toolInput ? shouldShowFullToolInput(event) : false;
            return (
              <>
                {toolInputSummary && <div className="tool-input-summary">{toolInputSummary}</div>}
                {toolInput && showFullInput && (
                  <details className="tool-input-details">
                    <summary>完整参数</summary>
                    <pre className="tool-input-block">{toolInput}</pre>
                  </details>
                )}
              </>
            );
          })()}
          {event.kind === 'observation' && event.toolName && (() => {
            const toolOutput = formatToolOutputForDisplay(event);
            if (!toolOutput) return null;
            const preview = buildToolOutputPreview(toolOutput);
            const summaryLabel = event.toolStatus === 'error' ? '查看错误输出' : '查看工具输出';
            return (
              <details className={`tool-output-details ${event.toolStatus === 'error' ? 'error' : 'success'}`}>
                <summary>{`${summaryLabel}：${preview}`}</summary>
                <pre className={`tool-output-block ${event.toolStatus === 'error' ? 'error' : 'success'}`}>{toolOutput}</pre>
              </details>
            );
          })()}
          {event.planSteps && event.planSteps.length > 0 && (
            <div className="message-plan">
              {event.planExplanation && (
                <div className="message-plan-explanation">{event.planExplanation}</div>
              )}
              <div className="message-plan-header">
                <span>计划清单</span>
                {event.planUpdatedAt && (
                  <span className="message-plan-updated-at">{new Date(event.planUpdatedAt).toLocaleString()}</span>
                )}
              </div>
              <ul className="message-plan-list">
                {event.planSteps.map((step, index) => (
                  <li key={`${step.step}-${index}`} className={`message-plan-step ${step.status}`}>
                    <span className="message-plan-step-icon">{planStepStatusIcon(step.status)}</span>
                    <span className="message-plan-step-text">{step.step}</span>
                    <span className="message-plan-step-status">{planStepStatusLabel(step.status)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {event.images && event.images.length > 0 && (
            <div className="message-images">
              {event.images.map((image) => (
                <div
                  key={image.id}
                  className="message-image-item"
                  onDoubleClick={() => {
                    if (onImageDoubleClick) onImageDoubleClick(image);
                  }}
                  title="双击预览图片"
                >
                  <img src={image.url} alt={image.name} />
                </div>
              ))}
            </div>
          )}
          {event.files && event.files.length > 0 && (
            <div className="message-files">
              {event.files.map((file) => (
                <div key={file.id} className="message-file-item">
                  {file.mimeType.startsWith('image/') ? '🖼' : '📄'} {file.name}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="message-footer">
          <span className="message-token-usage">{formatTokenUsage(event)}</span>
          {isUser && isError && onRetry && (
            <button
              type="button"
              className="message-retry-btn"
              onClick={() => onRetry(event)}
            >
              重发
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

MessageItem.displayName = 'MessageItem';

const ChatInput: React.FC<{
  draft: UserInputPayload;
  onDraftChange: React.Dispatch<React.SetStateAction<UserInputPayload>>;
  onSend: (payload: UserInputPayload) => void;
  onCreateNewSession?: () => Promise<void> | void;
  inputHistory: string[];
  inputCapability: InputCapability;
  isPaused: boolean;
  isAgentRunning: boolean;
  disabled?: boolean;
  dryrunTarget?: string | null;
  requestDetailsEnabled?: boolean;
  onToggleRequestDetails?: (enabled: boolean) => void;
  interruptTargetLabel?: string;
  onPauseWorkflow?: () => void;
  onResumeWorkflow?: () => void;
  onInterruptTurn?: () => Promise<boolean> | boolean;
}> = ({
  draft,
  onDraftChange,
  onSend,
  onCreateNewSession,
  inputHistory,
  inputCapability,
  isPaused,
  isAgentRunning,
  disabled,
  dryrunTarget,
  requestDetailsEnabled,
  onToggleRequestDetails,
  interruptTargetLabel,
  onPauseWorkflow,
  onResumeWorkflow,
  onInterruptTurn,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [inputWarning, setInputWarning] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [historySnapshot, setHistorySnapshot] = useState<string>('');
  const [reviewEnabled, setReviewEnabled] = useState<boolean>(DEFAULT_REVIEW_SETTINGS.enabled);
  const [reviewTarget, setReviewTarget] = useState<string>(DEFAULT_REVIEW_SETTINGS.target);
  const [reviewStrictness, setReviewStrictness] = useState<ReviewStrictness>(DEFAULT_REVIEW_SETTINGS.strictness);
  const [reviewMaxTurns, setReviewMaxTurns] = useState<number>(DEFAULT_REVIEW_SETTINGS.maxTurns);
  const [planModeEnabled, setPlanModeEnabled] = useState<boolean>(false);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const images = draft.images ?? [];
  const files = draft.files ?? [];
  const resolvedInterruptLabel = typeof interruptTargetLabel === 'string' && interruptTargetLabel.trim().length > 0
    ? interruptTargetLabel.trim()
    : '当前 agent';

  const handleSend = useCallback(() => {
    const sanitized = sanitizeDraftByCapability(draft, inputCapability);
    if (sanitized.reason) {
      setInputWarning(sanitized.reason);
      return;
    }
    if (sanitized.dropped > 0) {
      setInputWarning(`已过滤 ${sanitized.dropped} 个不受支持的附件`);
    } else {
      setInputWarning(null);
    }

    const normalizedText = sanitized.payload.text.trim();
    const hasAttachments = (sanitized.payload.images?.length ?? 0) > 0 || (sanitized.payload.files?.length ?? 0) > 0;
    const slashCommand = !hasAttachments ? parseSlashCommandInput(normalizedText) : null;
    if (slashCommand && !hasAttachments) {
      const resetDraft = () => {
        setHistoryCursor(null);
        setHistorySnapshot('');
        onDraftChange({ text: '', images: [], files: [] });
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      };

      if (slashCommand.name === 'new' || slashCommand.name === 'clear') {
        resetDraft();
        if (!onCreateNewSession) {
          setInputWarning('当前界面未接入新会话创建能力');
          return;
        }
        void Promise.resolve(onCreateNewSession()).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : '创建新会话失败';
          setInputWarning(message);
        });
        return;
      }

      if (slashCommand.name === 'compact') {
        onSend({ text: '/compact' });
        resetDraft();
        setInputWarning(null);
        return;
      }

      if (slashCommand.name === 'dryrun') {
        const tokens = slashCommand.args;
        let target: string | undefined;
        let textInput = slashCommand.rawArgs;
        if (tokens[0] && tokens[0].startsWith('@')) {
          target = tokens[0].slice(1);
          textInput = tokens.slice(1).join(' ').trim();
        }
        if (!textInput) {
          setInputWarning('dryrun 需要输入文本，例如：/dryrun @finger-orchestrator 请生成执行请求');
          return;
        }
        onSend({
          text: textInput,
          dryrun: true,
          ...(target ? { dryrunTarget: target } : {}),
        });
        resetDraft();
        setInputWarning(null);
        return;
      }

      if (slashCommand.name === 'plan') {
        const option = slashCommand.args[0]?.toLowerCase();
        const nextEnabled = option === 'off' || option === 'disable' || option === 'false'
          ? false
          : option === 'on' || option === 'enable' || option === 'true'
            ? true
            : true;
        setPlanModeEnabled(nextEnabled);
        resetDraft();
        setInputWarning(`计划模式已${nextEnabled ? '开启' : '关闭'}`);
        return;
      }

      if (slashCommand.name === 'review') {
        const [firstArg, ...restArgs] = slashCommand.args;
        const first = firstArg?.toLowerCase() ?? '';
        if (first === 'off' || first === 'disable' || first === 'false') {
          setReviewEnabled(false);
          resetDraft();
          setInputWarning('Review 已关闭');
          return;
        }

        if (first === 'strict' || first === 'mainline') {
          setReviewStrictness(first);
          const target = restArgs.join(' ').trim();
          if (target.length > 0) setReviewTarget(target);
          setReviewEnabled(true);
          resetDraft();
          setInputWarning(`Review 已开启（${first === 'strict' ? '严格' : '主线'}）`);
          return;
        }

        if (slashCommand.rawArgs.length > 0) {
          setReviewTarget(slashCommand.rawArgs);
        }
        setReviewEnabled(true);
        resetDraft();
        setInputWarning('Review 已开启');
        return;
      }

      if (slashCommand.name === 'status') {
        const reviewStatus = reviewEnabled
          ? `开启（${reviewStrictness === 'strict' ? '严格' : '主线'}，上限 ${reviewMaxTurns}）`
          : '关闭';
        setInputWarning(`状态：计划模式=${planModeEnabled ? '开启' : '关闭'}；Review=${reviewStatus}`);
        return;
      }

      if (slashCommand.name === 'help') {
        const implemented = listImplementedSlashCommands().map((item) => `/${item.name}`).join(' ');
        setInputWarning(`已接入命令：${implemented}`);
        return;
      }

      if (slashCommand.name === 'quit' || slashCommand.name === 'exit') {
        setInputWarning('Web 会话中不支持退出进程，请直接关闭页面或切换会话。');
        return;
      }

      const commandMeta = getSlashCommandDefinition(slashCommand.name);
      if (commandMeta) {
        setInputWarning(`/${slashCommand.name} 已识别，暂未接入（codex /commands 迁移中）`);
        return;
      }
    }

    const normalizedTarget = reviewTarget.trim();
    if (reviewEnabled && normalizedTarget.length === 0) {
      setInputWarning('已启用 Review，请先填写 Review 目标');
      return;
    }
    const normalizedMaxTurns = Number.isFinite(reviewMaxTurns)
      ? Math.max(0, Math.floor(reviewMaxTurns))
      : DEFAULT_REVIEW_SETTINGS.maxTurns;
    const payload: UserInputPayload = {
      ...sanitized.payload,
      ...(planModeEnabled ? { planModeEnabled: true } : {}),
      ...(reviewEnabled
        ? {
            review: {
              enabled: true,
              target: normalizedTarget,
              strictness: reviewStrictness,
              maxTurns: normalizedMaxTurns,
            },
          }
        : {}),
    };

    onSend(payload);
    setHistoryCursor(null);
    setHistorySnapshot('');

    onDraftChange({ text: '', images: [], files: [] });
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [
    draft,
    inputCapability,
    onCreateNewSession,
    onDraftChange,
    onSend,
    reviewEnabled,
    reviewMaxTurns,
    reviewStrictness,
    reviewTarget,
    planModeEnabled,
    reviewMaxTurns,
  ]);

  const handleDryrun = useCallback(() => {
    const sanitized = sanitizeDraftByCapability(draft, inputCapability);
    if (sanitized.reason) {
      setInputWarning(sanitized.reason);
      return;
    }
    if (sanitized.dropped > 0) {
      setInputWarning(`已过滤 ${sanitized.dropped} 个不受支持的附件`);
    } else {
      setInputWarning(null);
    }

    const normalizedText = sanitized.payload.text.trim();
    const hasAttachments = (sanitized.payload.images?.length ?? 0) > 0 || (sanitized.payload.files?.length ?? 0) > 0;
    if (!normalizedText && !hasAttachments) {
      setInputWarning('请输入内容后再 dryrun');
      return;
    }

    onSend({
      ...sanitized.payload,
      dryrun: true,
      ...(dryrunTarget ? { dryrunTarget } : {}),
    });
    setHistoryCursor(null);
    setHistorySnapshot('');
    onDraftChange({ text: '', images: [], files: [] });
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [draft, dryrunTarget, inputCapability, onDraftChange, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const textIsEmpty = draft.text.length === 0;
    const caretAtFirstLine =
      e.currentTarget.selectionStart === 0 &&
      e.currentTarget.selectionEnd === 0;
    const isArrowUp = e.key === 'ArrowUp' || e.keyCode === 38;
    const isArrowDown = e.key === 'ArrowDown' || e.keyCode === 40;
    const isEnter = e.key === 'Enter' || e.keyCode === 13;

    if (isArrowUp && inputHistory.length > 0 && (historyCursor !== null || (textIsEmpty && caretAtFirstLine))) {
      e.preventDefault();
      const nextCursor = historyCursor === null ? inputHistory.length - 1 : Math.max(0, historyCursor - 1);
      if (historyCursor === null) {
        setHistorySnapshot(draft.text);
      }
      setHistoryCursor(nextCursor);
      onDraftChange((prev) => ({ ...prev, text: inputHistory[nextCursor] }));
      return;
    }

    if (isArrowDown && historyCursor !== null) {
      e.preventDefault();
      const nextCursor = historyCursor + 1;
      if (nextCursor >= inputHistory.length) {
        setHistoryCursor(null);
        onDraftChange((prev) => ({ ...prev, text: historySnapshot }));
      } else {
        setHistoryCursor(nextCursor);
        onDraftChange((prev) => ({ ...prev, text: inputHistory[nextCursor] }));
      }
      return;
    }

    if (isEnter && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }, [draft.text, handleSend, historyCursor, historySnapshot, inputHistory, onDraftChange]);

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextText = e.target.value;
    if (historyCursor !== null) {
      setHistoryCursor(null);
      setHistorySnapshot('');
    }
    onDraftChange((prev) => ({ ...prev, text: nextText }));
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [historyCursor, onDraftChange]);

  const appendIncomingFiles = useCallback(async (incomingFiles: File[], folderPaths: string[] = []) => {
    if (incomingFiles.length === 0 && folderPaths.length === 0) return;

    const normalizedFolderPaths = folderPaths
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const newFiles = await createPreviewFiles(incomingFiles);
    const normalizedFiles: RuntimeFile[] = [];
    const normalizedImages: RuntimeImage[] = [];
    let droppedCount = 0;

    for (const file of newFiles) {
      if (file.mimeType.startsWith('image/')) {
        const image = buildImageFromFile(file);
        if (image && inputCapability.acceptImages) {
          normalizedImages.push(image);
        } else {
          droppedCount += 1;
        }
        continue;
      }
      if (capabilityAllowsFile(file, inputCapability)) {
        normalizedFiles.push(file);
      } else {
        droppedCount += 1;
      }
    }

    if (
      normalizedFiles.length === 0
      && normalizedImages.length === 0
      && normalizedFolderPaths.length === 0
      && droppedCount > 0
    ) {
      setInputWarning('当前 Agent 不支持该附件类型');
      return;
    }

    const folderText = normalizedFolderPaths.join('\n');
    onDraftChange((prev) => ({
      ...prev,
      ...(normalizedFiles.length > 0 ? { files: [...(prev.files ?? []), ...normalizedFiles] } : {}),
      ...(normalizedImages.length > 0 ? { images: [...(prev.images ?? []), ...normalizedImages] } : {}),
      ...(folderText.length > 0 ? { text: mergeDraftText(prev.text, folderText) } : {}),
    }));
    if (droppedCount > 0) {
      setInputWarning(`已过滤 ${droppedCount} 个不受支持的附件`);
    } else {
      setInputWarning(null);
    }
  }, [inputCapability, onDraftChange]);

  const handleImageChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!inputCapability.acceptImages) {
      setInputWarning('当前 Agent 不支持图片输入');
      e.target.value = '';
      return;
    }
    const incoming = fileList ? Array.from(fileList) : [];
    void appendIncomingFiles(incoming);
    e.target.value = '';
  }, [appendIncomingFiles, inputCapability.acceptImages]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    const incoming = fileList ? Array.from(fileList) : [];
    void appendIncomingFiles(incoming);
    e.target.value = '';
  }, [appendIncomingFiles]);

  const handleTextareaPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items ?? []);
    if (items.length === 0) return;
    const filesFromClipboard: File[] = [];
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      filesFromClipboard.push(file);
    }
    if (filesFromClipboard.length === 0) return;
    e.preventDefault();
    void appendIncomingFiles(filesFromClipboard);
  }, [appendIncomingFiles]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!isDragOver) setIsDragOver(true);
  }, [isDragOver]);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const nextTarget = e.relatedTarget as Node | null;
    if (nextTarget && e.currentTarget.contains(nextTarget)) return;
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    const folderPaths: string[] = [];
    const items = Array.from(e.dataTransfer.items ?? []);
    for (const item of items) {
      const withEntry = item as unknown as { webkitGetAsEntry?: () => WebkitFileSystemEntry | null };
      const entry = withEntry.webkitGetAsEntry?.();
      if (!entry || !entry.isDirectory) continue;
      const fullPath = typeof entry.fullPath === 'string' ? entry.fullPath.trim() : '';
      if (fullPath.length > 0) {
        folderPaths.push(fullPath);
      } else if (entry.name.trim().length > 0) {
        folderPaths.push(entry.name.trim());
      }
    }
    void appendIncomingFiles(files, folderPaths);
  }, [appendIncomingFiles]);

  const removeImage = useCallback((id: string) => {
    onDraftChange((prev) => ({
      ...prev,
      images: (prev.images ?? []).filter((img) => img.id !== id),
    }));
  }, [onDraftChange]);

  const removeFile = useCallback((id: string) => {
    onDraftChange((prev) => ({
      ...prev,
      files: (prev.files ?? []).filter((file) => file.id !== id),
    }));
  }, [onDraftChange]);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
  }, [draft.text]);

  const canSend = draft.text.trim().length > 0 || images.length > 0 || files.length > 0;
  const handleInterrupt = useCallback(() => {
    if (!onInterruptTurn) return;
    void Promise.resolve(onInterruptTurn()).then((stopped) => {
      if (!stopped) {
        setInputWarning('当前没有可停止的运行回合');
      } else {
        setInputWarning(null);
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '停止失败';
      setInputWarning(message);
    });
  }, [onInterruptTurn]);

  return (
    <div className="chat-input-container">
      {images.length > 0 && (
        <div className="image-preview-bar">
          {images.map((img) => (
            <div key={img.id} className="image-preview-chip">
              <img src={img.url} alt={img.name} />
              <button className="remove-btn" onClick={() => removeImage(img.id)}>×</button>
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="file-preview-bar">
          {files.map((file) => (
            <div key={file.id} className="file-preview-chip">
              <span className="file-name">{file.name}</span>
              <button className="remove-btn" onClick={() => removeFile(file.id)}>×</button>
            </div>
          ))}
        </div>
      )}

      <div className="composer-shell">
        <div
          className={`textarea-wrapper ${isDragOver ? 'drag-over' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <textarea
            data-testid="chat-input"
            ref={textareaRef}
            value={draft.text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={handleTextareaPaste}
            placeholder={isPaused ? '系统已暂停，输入指令后点击继续' : '输入任务指令... (Shift+Enter 换行，/new 新会话)'}
            rows={4}
            disabled={disabled}
          />
        </div>

        <div className="composer-review">
          <div className="composer-mode-toggles">
            <label className="composer-review-toggle">
              <input
                type="checkbox"
                checked={planModeEnabled}
                onChange={(e) => setPlanModeEnabled(e.target.checked)}
                disabled={disabled}
              />
              <span>计划模式</span>
            </label>
            <label className="composer-review-toggle">
              <input
                type="checkbox"
                checked={reviewEnabled}
                onChange={(e) => setReviewEnabled(e.target.checked)}
                disabled={disabled}
              />
              <span>启用 Review</span>
            </label>
            <span className="review-apply-hint">设置在发送时生效，运行中的回合不受影响</span>
          </div>
          {reviewEnabled && (
            <div className="composer-review-fields">
              <input
                className="review-target-input"
                type="text"
                value={reviewTarget}
                onChange={(e) => setReviewTarget(e.target.value)}
                placeholder="Review 目标（必填）"
                disabled={disabled}
              />
              <select
                className="review-strictness-select"
                value={reviewStrictness}
                onChange={(e) => setReviewStrictness(e.target.value as ReviewStrictness)}
                disabled={disabled}
              >
                <option value="mainline">主线合格即可</option>
                <option value="strict">必须完全合格</option>
              </select>
              <label className="review-maxturns-field">
                <span>最多轮次</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={reviewMaxTurns}
                  onChange={(e) => {
                    const parsed = Number.parseInt(e.target.value, 10);
                    if (!Number.isFinite(parsed) || parsed < 0) {
                      setReviewMaxTurns(0);
                      return;
                    }
                    setReviewMaxTurns(parsed);
                  }}
                  disabled={disabled}
                />
                <span className="review-maxturns-hint">0 = 无限</span>
              </label>
            </div>
          )}
        </div>

        <div className="composer-toolbar">
          <div className="composer-controls">
            <button
              type="button"
              className="control-btn danger"
              onClick={handleInterrupt}
              disabled={disabled || !isAgentRunning}
              title={`中断当前 ${resolvedInterruptLabel} 回合`}
            >
              停止当前回合
            </button>
            {(onPauseWorkflow && onResumeWorkflow) && (
              <button
                type="button"
                className={`control-btn ${isPaused ? 'paused' : ''}`}
                onClick={isPaused ? onResumeWorkflow : onPauseWorkflow}
                disabled={disabled}
                title={`仅影响工作流状态机，不会中断当前 ${resolvedInterruptLabel} 回合`}
              >
                {isPaused ? '继续流程' : '暂停流程'}
              </button>
            )}
          </div>
          <div className="composer-tools">
            <label className="attach-btn" title="添加图片">
              🖼
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={handleImageChange}
                disabled={disabled}
              />
            </label>
            <label className="attach-btn" title="添加文件">
              📄
              <input
                type="file"
                multiple
                onChange={handleFileChange}
                disabled={disabled}
              />
            </label>
          </div>

         <button
           className="send-btn dryrun-btn"
           onClick={handleDryrun}
           disabled={!canSend || disabled}
           data-testid="dryrun-btn"
           title="Dryrun：查看注入提示词与工具"
        >
          <span>DRY</span>
        </button>
        {requestDetailsEnabled !== undefined && (
         <button
           className={`send-btn request-details-btn${requestDetailsEnabled ? ' active' : ''}`}
           onClick={() => onToggleRequestDetails?.(!requestDetailsEnabled)}
           disabled={disabled}
           data-testid="request-details-btn"
           title={requestDetailsEnabled ? '关闭请求详情' : '显示请求详情：发送后查看完整请求体'}
         >
           <span>DETAILS</span>
         </button>
        )}
        <button
           className="send-btn"
           onClick={handleSend}
           disabled={!canSend || disabled}
         >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
      {inputWarning && <div className="input-warning">{inputWarning}</div>}
    </div>
  );
};

export const ChatInterface: React.FC<ChatInterfaceProps> = ({
  executionState,
  agents,
  events,
  contextEditableEventIds,
  agentRunStatus,
  panelTitle,
  showRuntimeModeBadge = true,
  runtimeOverview,
  contextLabel,
  toolPanelOverview,
  onSendMessage,
  onEditMessage,
  onDeleteMessage,
  onCreateNewSession,
  onPause,
  onResume,
  onInterruptTurn,
  isPaused,
  isConnected,
  onAgentClick,
  selectedAgentId,
  eventFilterAgentId,
  inputCapability,
  inputLockState,
  clientId,
  onAcquireInputLock,
  onReleaseInputLock,
  debugSnapshotsEnabled = false,
  onToggleDebugSnapshots,
  debugSnapshots = [],
  onClearDebugSnapshots,
  orchestratorRuntimeMode,
  onUpdateToolExposure,
  onToggleRequestDetails,
  requestDetailsEnabled = false,
  interruptTargetLabel,
}) => {
  const chatRef = useRef<HTMLDivElement>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [draft, setDraft] = useState<UserInputPayload>({ text: '', images: [], files: [] });
  const [visibleEventCount, setVisibleEventCount] = useState<number>(MESSAGE_PAGE_SIZE);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<RuntimeImage | null>(null);
  const effectiveInputCapability = inputCapability ?? DEFAULT_INPUT_CAPABILITY;
  const toolDashboard = useMemo(
    () => buildToolDashboard(events, toolPanelOverview?.availableTools ?? [], toolPanelOverview?.exposedTools ?? []),
    [events, toolPanelOverview?.availableTools, toolPanelOverview?.exposedTools],
  );
  const [toolTab, setToolTab] = useState<'summary' | 'exposure'>('summary');
  const [toolPanelCollapsed, setToolPanelCollapsed] = useState(false);
  const [toolSelection, setToolSelection] = useState<Set<string>>(new Set());
  const toolSelectionRef = useRef<Set<string>>(new Set());
  const [toolUpdateError, setToolUpdateError] = useState<string | null>(null);
  const [toolUpdatePending, setToolUpdatePending] = useState(false);
  const orchestratorPhase = useMemo(
    () => formatOrchestratorPhase(executionState?.orchestratorPhase),
    [executionState?.orchestratorPhase],
  );
  const runtimeModeText = useMemo(() => {
    if (!orchestratorRuntimeMode) return null;
    const base = orchestratorRuntimeMode.mode.trim();
    if (!base) return null;
    if (orchestratorRuntimeMode.runnerModuleId && orchestratorRuntimeMode.runnerModuleId.trim().length > 0) {
      return `${base} · ${orchestratorRuntimeMode.runnerModuleId.trim()}`;
    }
    return base;
  }, [orchestratorRuntimeMode]);
  const displayedSnapshots = useMemo(
    () => debugSnapshots.slice(-60).reverse(),
    [debugSnapshots],
  );

  useEffect(() => {
    if (!chatRef.current) return;
    chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [events]);

  useEffect(() => {
    const available = (toolPanelOverview?.availableTools ?? [])
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (available.length === 0) {
      const empty = new Set<string>();
      toolSelectionRef.current = empty;
      setToolSelection(empty);
      return;
    }
    const exposed = new Set(
      (toolPanelOverview?.exposedTools ?? [])
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    );
    if (exposed.size === 0) {
      const all = new Set(available);
      toolSelectionRef.current = all;
      setToolSelection(all);
      return;
    }
    const next = new Set(available.filter((item) => exposed.has(item)));
    toolSelectionRef.current = next;
    setToolSelection(next);
  }, [toolPanelOverview?.availableTools, toolPanelOverview?.exposedTools]);

  const handleToggleToolExposure = useCallback(async (toolName: string) => {
    if (!onUpdateToolExposure) return;
    const normalized = toolName.trim();
    if (!normalized) return;
    const base = new Set(toolSelectionRef.current);
    if (base.has(normalized)) {
      base.delete(normalized);
    } else {
      base.add(normalized);
    }
    toolSelectionRef.current = base;
    setToolSelection(base);
    setToolUpdateError(null);
    setToolUpdatePending(true);
    try {
      const ok = await Promise.resolve(onUpdateToolExposure(Array.from(base)));
      if (!ok) {
        setToolUpdateError('工具暴露更新失败');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '工具暴露更新失败';
      setToolUpdateError(message);
    } finally {
      setToolUpdatePending(false);
    }
  }, [onUpdateToolExposure]);

  useEffect(() => {
    const closeMenu = (event: MouseEvent): void => {
      if (event.button === 2) return;
      setContextMenu(null);
    };
    const closeOnScroll = (): void => setContextMenu(null);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setPreviewImage(null);
      }
    };

    document.addEventListener('mousedown', closeMenu);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', closeOnScroll, true);

    return () => {
      document.removeEventListener('mousedown', closeMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', closeOnScroll, true);
    };
  }, []);

  const handleScroll = useCallback(() => {
    if (!chatRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatRef.current;
    setShowScrollToBottom(scrollHeight - scrollTop - clientHeight > 100);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
      setShowScrollToBottom(false);
    }
  }, []);

  const inputHistory = useMemo(() => {
    const collected: string[] = [];
    for (const event of events) {
      if (event.role !== 'user') continue;
      const text = event.content.trim();
      if (text.length === 0) continue;
      if (collected.length > 0 && collected[collected.length - 1] === text) continue;
      collected.push(text);
    }
    return collected.length > 100 ? collected.slice(collected.length - 100) : collected;
  }, [events]);

  const handleSend = useCallback(async (payload: UserInputPayload) => {
    // 尝试获取输入锁（best-effort，不阻断发送）
    let acquired = true;
    if (onAcquireInputLock) {
      acquired = await onAcquireInputLock();
      if (!acquired) {
        console.warn('[ChatInterface] Failed to acquire input lock, continue send without lock');
      }
    }
    
    try {
      await Promise.resolve(onSendMessage(payload));
    } finally {
      // 释放输入锁
      if (onReleaseInputLock && acquired) {
        onReleaseInputLock();
      }
    }
  }, [onSendMessage, onAcquireInputLock, onReleaseInputLock]);

  const handleRetryMessage = useCallback((event: RuntimeEvent) => {
    void onSendMessage({
      text: event.content,
      ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
      ...(event.files && event.files.length > 0 ? { files: event.files } : {}),
    });
  }, [onSendMessage]);

  const handleMessageContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>, event: RuntimeEvent) => {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - CONTEXT_MENU_WIDTH);
    const y = Math.min(e.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT);
    setContextMenu({
      x: Math.max(8, x),
      y: Math.max(8, y),
      eventId: event.id,
    });
  }, []);

  const agentStatusMap = useMemo(() => {
    const map = new Map<string, string>();
    agents.forEach((agent) => map.set(agent.id, agent.status));
    return map;
  }, [agents]);

  const eventsWithKeys = useMemo<DecoratedEvent[]>(() => {
    return events
      .map((event, index) => {
        const eventId = event.id || `${event.timestamp}-${event.role}-${index}`;
        const merged: DecoratedEvent = {
          ...event,
          id: eventId,
          eventId,
          key: eventId,
          content: event.content,
          images: event.images,
          files: event.files,
        };

        return merged;
      });
  }, [events]);

  const filteredByAgentEvents = useMemo(() => {
    if (!eventFilterAgentId) return eventsWithKeys;
    return eventsWithKeys.filter((event) => {
      if (event.role === 'user') return true;
      const metadata = (event as any).metadata;
      const metadataEvent = metadata && typeof metadata === 'object' ? (metadata as any).event : null;
      const resolvedAgentIds = [
        (event as any).agentId,
        metadataEvent?.agentId,
        metadataEvent?.targetAgentId,
        metadataEvent?.sourceAgentId,
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (resolvedAgentIds.length === 0) return true;
      return resolvedAgentIds.includes(eventFilterAgentId);
    });
  }, [eventFilterAgentId, eventsWithKeys]);

  const displayedEvents = useMemo(
    () => filteredByAgentEvents.slice(-Math.max(1, visibleEventCount)),
    [filteredByAgentEvents, visibleEventCount],
  );

  const hiddenEventsCount = filteredByAgentEvents.length - displayedEvents.length;

  const activeMenuEvent = useMemo<DecoratedEvent | null>(() => {
    if (!contextMenu) return null;
    return eventsWithKeys.find((event) => event.eventId === contextMenu.eventId) ?? null;
  }, [contextMenu, eventsWithKeys]);

  const editableEventIds = useMemo(
    () => new Set(contextEditableEventIds ?? eventsWithKeys.map((event) => event.eventId)),
    [contextEditableEventIds, eventsWithKeys],
  );

  const activeMenuEventEditable = useMemo(() => {
    if (!activeMenuEvent) return false;
    if (activeMenuEvent.role !== 'user' && activeMenuEvent.role !== 'agent') return false;
    return editableEventIds.has(activeMenuEvent.eventId);
  }, [activeMenuEvent, editableEventIds]);

  const handleEditMessage = useCallback(() => {
    if (!activeMenuEvent) return;
    if (!activeMenuEventEditable) {
      setOperationMessage('该消息超出当前上下文窗口，不能编辑');
      setContextMenu(null);
      return;
    }
    if (!onEditMessage) return;
    const nextText = window.prompt('编辑消息内容', activeMenuEvent.content);
    if (nextText === null) return;
    void onEditMessage(activeMenuEvent.eventId, nextText).then((ok) => {
      if (!ok) {
        setOperationMessage('消息编辑失败');
      } else {
        setOperationMessage(null);
      }
    });
    setContextMenu(null);
  }, [activeMenuEvent, activeMenuEventEditable, onEditMessage]);

  const handleDeleteMessage = useCallback(() => {
    if (!activeMenuEvent) return;
    if (!activeMenuEventEditable) {
      setOperationMessage('该消息超出当前上下文窗口，不能删除');
      setContextMenu(null);
      return;
    }
    if (!onDeleteMessage) return;
    void onDeleteMessage(activeMenuEvent.eventId).then((ok) => {
      if (!ok) {
        setOperationMessage('消息删除失败');
      } else {
        setOperationMessage(null);
      }
    });
    setContextMenu(null);
  }, [activeMenuEvent, activeMenuEventEditable, onDeleteMessage]);

  const handleCopyText = useCallback(async () => {
    if (!activeMenuEvent) return;
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return;
    await navigator.clipboard.writeText(activeMenuEvent.content);
    setContextMenu(null);
  }, [activeMenuEvent]);

  const handleCopyImage = useCallback(async () => {
    if (!activeMenuEvent) return;
    await copyImageToClipboard(activeMenuEvent.images?.[0]);
    setContextMenu(null);
  }, [activeMenuEvent]);

  const handleInsertToDraft = useCallback(() => {
    if (!activeMenuEvent) return;

    const incomingImages = activeMenuEvent.images ?? [];
    const incomingFiles = activeMenuEvent.files ?? [];

    setDraft((prev) => ({
      text: mergeDraftText(prev.text, activeMenuEvent.content),
      images: mergeImages(prev.images ?? [], incomingImages),
      files: mergeFiles(prev.files ?? [], incomingFiles),
    }));
    setContextMenu(null);
  }, [activeMenuEvent]);

  const handleResendMessage = useCallback(() => {
    if (!activeMenuEvent) return;

    const payload: UserInputPayload = {
      text: activeMenuEvent.content,
      ...(activeMenuEvent.images && activeMenuEvent.images.length > 0 ? { images: activeMenuEvent.images } : {}),
      ...(activeMenuEvent.files && activeMenuEvent.files.length > 0 ? { files: activeMenuEvent.files } : {}),
    };
    void handleSend(payload);
    setContextMenu(null);
  }, [activeMenuEvent, handleSend]);

  const handleLoadMoreEvents = useCallback(() => {
    setVisibleEventCount((prev) => prev + MESSAGE_PAGE_SIZE);
  }, []);

  return (
    <div className="chat-interface">
      <div className="chat-header">
        <div className="header-title">
          <span className="title-text">{panelTitle || '对话面板'}</span>
          {!isConnected && <span className="connection-badge offline">离线</span>}
          {showRuntimeModeBadge && runtimeModeText && (
            <span className="runtime-mode-badge">{runtimeModeText}</span>
          )}
        </div>
        <div className="header-status">
          <label className="debug-toggle">
            <input
              type="checkbox"
              checked={debugSnapshotsEnabled}
              onChange={(event) => onToggleDebugSnapshots?.(event.target.checked)}
            />
            <span>Debug 快照</span>
          </label>
          <span className={`header-status-dot ${agentRunStatus?.phase ?? 'idle'}`} />
          <span className="header-status-text">
            {agentRunStatus?.phase === 'running'
              ? '运行中'
              : agentRunStatus?.phase === 'dispatching'
                ? '分配中'
              : agentRunStatus?.phase === 'error'
                ? '异常'
                : isPaused
                  ? '流程已暂停'
                  : '就绪'}
          </span>
          {orchestratorPhase && <span className="header-phase-text">[{orchestratorPhase}]</span>}
        </div>
      </div>

      <div className="chat-messages" ref={chatRef} onScroll={handleScroll}>
        {eventsWithKeys.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <div className="empty-text">开始对话，输入任务指令...</div>
          </div>
        ) : (
          <>
            {hiddenEventsCount > 0 && (
              <button type="button" className="load-more-btn" onClick={handleLoadMoreEvents}>
                加载更早消息（{hiddenEventsCount} 条）
              </button>
            )}
            {displayedEvents.map((event) => (
              <MessageItem
                key={event.key}
                event={event}
                agentStatus={event.agentId ? agentStatusMap.get(event.agentId) : undefined}
                onAgentClick={onAgentClick}
                onRetry={handleRetryMessage}
                onImageDoubleClick={setPreviewImage}
                onContextMenu={handleMessageContextMenu}
              />
            ))}
          </>
        )}
      </div>

      {showScrollToBottom && (
        <button className="scroll-to-bottom-btn" onClick={scrollToBottom}>
          ↓ 滚动到底部
        </button>
      )}

      {agentRunStatus && (
        <div className={`agent-run-status ${agentRunStatus.phase}`}>
          <span className={`agent-run-dot ${(agentRunStatus.phase === 'running' || agentRunStatus.phase === 'dispatching') ? 'pulsing' : ''}`} />
          <span className="agent-run-text">{agentRunStatus.text}</span>
        </div>
      )}
      <div className="runtime-overview-bar">
        {contextLabel && <div className="runtime-overview-line">{contextLabel}</div>}
        <div className="runtime-overview-line">{formatRuntimeTokenSummary(runtimeOverview)}</div>
        <div className="runtime-overview-line">{formatRuntimeOverview(runtimeOverview)}</div>
        {formatRuntimePaths(runtimeOverview) && (
          <div className="runtime-overview-line">{formatRuntimePaths(runtimeOverview)}</div>
        )}
      </div>
      <div className={`tool-dashboard ${toolPanelCollapsed ? 'collapsed' : ''}`}>
        <div className="tool-dashboard-header">
          <div className="tool-dashboard-tabs">
            <button
              type="button"
              className={toolTab === 'summary' ? 'active' : ''}
              onClick={() => setToolTab('summary')}
            >
              概览
            </button>
            <button
              type="button"
              className={toolTab === 'exposure' ? 'active' : ''}
              onClick={() => setToolTab('exposure')}
            >
              暴露工具
            </button>
          </div>
          <div className="tool-dashboard-summary">
            <span>可用 {toolPanelOverview?.availableTools.length ?? 0}</span>
            <span>暴露 {toolPanelOverview?.exposedTools.length ?? 0}</span>
            <span>工具调用 {toolDashboard.total}</span>
            <span className="ok">成功 {toolDashboard.success}</span>
            <span className="fail">失败 {toolDashboard.failed}</span>
          </div>
          <div className="tool-dashboard-actions">
            <button
              type="button"
              className="tool-dashboard-toggle"
              onClick={() => setToolPanelCollapsed((prev) => !prev)}
            >
              {toolPanelCollapsed ? '展开工具' : '收起工具'}
            </button>
          </div>
        </div>
        {toolPanelCollapsed && (
          <div className="tool-dashboard-collapsed">工具面板已折叠</div>
        )}
        {!toolPanelCollapsed && toolTab === 'summary' && toolDashboard.tools.length > 0 && (
          <div className="tool-dashboard-list">
            {toolDashboard.tools.slice(0, 8).map((tool) => (
              <div key={`${tool.category}-${tool.name}`} className={`tool-dashboard-item ${tool.exposed ? 'exposed' : ''}`}>
                <span className="tool-name">
                  [{tool.category}] {tool.name}
                  {tool.exposed ? ' · 已暴露' : tool.available ? ' · 可用' : ''}
                </span>
                <span className="tool-count">总 {tool.total} / 成 {tool.success} / 败 {tool.failed}</span>
              </div>
            ))}
          </div>
        )}
        {!toolPanelCollapsed && toolTab === 'exposure' && (
          <div className="tool-exposure-panel">
            <div className="tool-exposure-hint">
              未勾选工具将不会暴露给模型，下一轮请求立即生效。
            </div>
            <div className="tool-exposure-meta">
              {toolUpdatePending ? '更新中...' : '实时生效'}
              {toolUpdateError ? ` · ${toolUpdateError}` : ''}
            </div>
            <div className="tool-exposure-grid">
              {(() => {
                const items = (toolPanelOverview?.availableTools ?? []).slice();
                items.sort((a, b) => a.localeCompare(b));
                return items;
              })().map((tool) => {
                const normalizedTool = tool.trim();
                const checked = toolSelection.has(normalizedTool);
                return (
                  <label key={tool} className={`tool-exposure-item ${checked ? 'checked' : ''}`}>
                    <input
                      type="checkbox"
                      aria-label={tool}
                      checked={checked}
                      disabled={!onUpdateToolExposure || toolUpdatePending}
                      onChange={() => { void handleToggleToolExposure(normalizedTool); }}
                    />
                    <span>{tool}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {debugSnapshotsEnabled && (
        <div className="debug-snapshots-panel">
          <div className="debug-snapshots-header">
            <span>Debug Snapshots ({debugSnapshots.length})</span>
            <button
              type="button"
              className="debug-snapshots-clear-btn"
              onClick={() => onClearDebugSnapshots?.()}
            >
              清空
            </button>
          </div>
          <div className="debug-snapshots-list">
            {displayedSnapshots.length === 0 ? (
              <div className="debug-snapshot-empty">暂无快照</div>
            ) : (
              displayedSnapshots.map((snapshot) => (
                <div key={snapshot.id} className="debug-snapshot-item">
                  <span className="debug-snapshot-time">{new Date(snapshot.timestamp).toLocaleTimeString()}</span>
                  <span className="debug-snapshot-stage">{snapshot.stage}</span>
                  <span className="debug-snapshot-summary">{snapshot.summary}</span>
                  {typeof snapshot.attempt === 'number' && <span className="debug-snapshot-attempt">#{snapshot.attempt}</span>}
                  {snapshot.phase && <span className="debug-snapshot-phase">{snapshot.phase}</span>}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {inputLockState && inputLockState.lockedBy && inputLockState.lockedBy !== clientId && (
        <div className="input-lock-indicator">
          <span className="lock-icon">🔒</span>
          <span className="lock-text">其他端（{inputLockState.lockedBy}）正在输入...</span>
        </div>
      )}

      {contextMenu && activeMenuEvent && (
        <div
          className="chat-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button type="button" className="menu-item" onClick={handleEditMessage} disabled={!activeMenuEventEditable}>编辑消息</button>
          <button type="button" className="menu-item" onClick={handleDeleteMessage} disabled={!activeMenuEventEditable}>删除消息</button>
          <button type="button" className="menu-item" onClick={() => { void handleCopyText(); }}>复制文本</button>
          <button
            type="button"
            className="menu-item"
            onClick={() => { void handleCopyImage(); }}
            disabled={!activeMenuEvent.images || activeMenuEvent.images.length === 0}
          >
            复制图片
          </button>
          <button type="button" className="menu-item" onClick={handleInsertToDraft}>插入输入框</button>
          <button type="button" className="menu-item" onClick={handleResendMessage}>重发消息</button>
        </div>
      )}

      <ChatInput
        draft={draft}
        onDraftChange={setDraft}
        onSend={handleSend}
        onCreateNewSession={onCreateNewSession}
        inputHistory={inputHistory}
        inputCapability={effectiveInputCapability}
        isPaused={isPaused}
        isAgentRunning={agentRunStatus?.phase === 'running'}
        dryrunTarget={selectedAgentId}
        requestDetailsEnabled={requestDetailsEnabled}
        onToggleRequestDetails={onToggleRequestDetails}
        interruptTargetLabel={interruptTargetLabel}
        onPauseWorkflow={executionState ? onPause : undefined}
        onResumeWorkflow={executionState ? onResume : undefined}
        onInterruptTurn={onInterruptTurn}
        disabled={!isConnected || (inputLockState?.lockedBy !== null && inputLockState?.lockedBy !== clientId)}
      />
      {operationMessage && <div className="operation-hint">{operationMessage}</div>}

      {previewImage && (
        <div className="image-preview-modal" onClick={() => setPreviewImage(null)}>
          <div className="image-preview-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="image-preview-header">
              <span>{previewImage.name}</span>
              <button type="button" onClick={() => setPreviewImage(null)}>关闭</button>
            </div>
            <img src={previewImage.url} alt={previewImage.name} />
          </div>
        </div>
      )}
    </div>
  );
};
