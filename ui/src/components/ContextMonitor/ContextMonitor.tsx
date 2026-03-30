import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWebSocket } from '../../hooks/useWebSocket.js';
import type { WsMessage } from '../../api/types.js';
import './ContextMonitor.css';

interface ContextMonitorMessage {
  id: string;
  slot?: number;
  role: string;
  content: string;
  timestampIso: string;
  tokenCount: number;
  contextZone?: 'working_set' | 'historical_memory';
}

interface ContextMonitorEvent {
  slot: number;
  id: string;
  timestampIso: string;
  eventType: string;
  role: string;
  agentId: string;
  preview: string;
  finishReason?: string;
  contextHistorySource?: string;
  contextBuilderBypassed?: boolean;
  contextBuilderBypassReason?: string;
  contextBuilderRebuilt?: boolean;
  modelRound?: number;
  historyItemsCount?: number;
  contextUsagePercent?: number;
  contextTokensInWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface ContextMonitorRound {
  id: string;
  slotStart: number;
  slotEnd: number;
  startTimeIso: string;
  endTimeIso: string;
  userPrompt: string;
  finishReason?: string;
  contextStrategy?: {
    source?: string;
    bypassed?: boolean;
    bypassReason?: string;
    rebuilt?: boolean;
    derivedFromEventType?: string;
    derivedFromSlot?: number;
  };
  modelSummary?: {
    round?: number;
    historyItemsCount?: number;
    contextUsagePercent?: number;
    contextTokensInWindow?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    derivedFromSlot?: number;
  };
  contextMessages: ContextMonitorMessage[];
  events: ContextMonitorEvent[];
}

interface ContextMonitorResponse {
  success: boolean;
  sessionId: string;
  projectPath: string;
  agentId: string;
  updatedAt: string;
  contextBuilder: {
    enabled: boolean;
    historyBudgetTokens?: number;
    budgetRatio: number;
    targetBudget: number;
    historyOnly?: boolean;
    halfLifeMs: number;
    includeMemoryMd: boolean;
    enableModelRanking: boolean | 'dryrun';
    rankingProviderId: string;
    mode: string;
  };
  contextBuild: {
    ok: boolean;
    error?: string;
    totalTokens?: number;
    memoryMdIncluded?: boolean;
    taskBlockCount?: number;
    filteredTaskBlockCount?: number;
    buildTimestamp?: string;
    metadata?: {
      rawTaskBlockCount: number;
      timeWindowFilteredCount: number;
      budgetTruncatedCount: number;
      budgetTruncatedTasks?: Array<{
        id: string;
        tokenCount: number;
        startTimeIso: string;
        topic?: string;
        tags?: string[];
        summary?: string;
      }>;
      targetBudget: number;
      actualTokens: number;
      buildMode?: string;
      removedIrrelevantCount?: number;
      supplementedCount?: number;
      removedTokens?: number;
      supplementedTokens?: number;
      workingSetTaskBlockCount?: number;
      historicalTaskBlockCount?: number;
      workingSetMessageCount?: number;
      historicalMessageCount?: number;
      workingSetTokens?: number;
      historicalTokens?: number;
    };
    messages: Array<{
      id: string;
      role: string;
      content: string;
      timestampIso: string;
      tokenCount: number;
      contextZone?: 'working_set' | 'historical_memory';
    }>;
  };
  slotWindow: {
    total: number;
    start: number;
    end: number;
    limit: number;
  };
  rounds: ContextMonitorRound[];
}

interface ContextMonitorProps {
  sessionId?: string;
  label?: string;
  liveUpdatesEnabled?: boolean;
  debounceMs?: number;
  externalCommand?: {
    id: string;
    action: 'focus_latest_round' | 'focus_latest_strategy_change' | 'step_compare_prev' | 'step_compare_next';
  } | null;
}

function formatTimestamp(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function roleLabel(role: string): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  if (role === 'system') return '系统';
  if (role === 'orchestrator') return '编排';
  return role || '未知';
}

function contextZoneLabel(zone?: 'working_set' | 'historical_memory'): string {
  if (zone === 'working_set') return '工作集';
  if (zone === 'historical_memory') return '历史';
  return '未分区';
}

function eventLabel(eventType: string): string {
  if (eventType === 'session_message') return '消息';
  if (eventType === 'turn_start') return '轮次开始';
  if (eventType === 'turn_complete') return '轮次完成';
  if (eventType === 'model_round') return '模型轮';
  if (eventType === 'tool_call') return '工具调用';
  if (eventType === 'tool_result') return '工具结果';
  if (eventType === 'tool_error') return '工具错误';
  if (eventType === 'dispatch') return '派发';
  if (eventType === 'task_complete') return '任务完成';
  return eventType;
}

function shorten(text: string, max = 100): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function collectRoundContextSlots(round: ContextMonitorRound | null | undefined): Set<number> {
  if (!round) return new Set<number>();
  const slots = round.contextMessages
    .map((msg) => msg.slot)
    .filter((slot): slot is number => typeof slot === 'number' && Number.isFinite(slot));
  return new Set(slots);
}

function describeContextStrategy(round: ContextMonitorRound | null | undefined): {
  tag: string;
  detail: string;
  tone: 'green' | 'blue' | 'amber' | 'gray';
} {
  if (!round?.contextStrategy) {
    return { tag: '未知', detail: '当前 round 未记录策略元信息', tone: 'gray' };
  }
  const strategy = round.contextStrategy;
  if (strategy.bypassed === true) {
    const reason = strategy.bypassReason ? `（${strategy.bypassReason}）` : '';
    return { tag: `RAW_SESSION${reason}`, detail: '跳过 context builder 重排，直接使用原始会话顺序', tone: 'amber' };
  }
  if (strategy.source === 'context_builder' || strategy.rebuilt === true) {
    return { tag: 'CONTEXT_BUILDER', detail: '使用 context builder 重建后的历史上下文', tone: 'green' };
  }
  if (strategy.source === 'raw_session') {
    return { tag: 'RAW_SESSION', detail: '使用原始会话历史（未显式重建）', tone: 'blue' };
  }
  return { tag: strategy.source || '未知', detail: '策略已记录，但来源字段不完整', tone: 'gray' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRelevantSessionMessage(msg: WsMessage, sessionId: string): boolean {
  const payload = isRecord(msg.payload) ? msg.payload : {};
  const hints = [
    typeof msg.sessionId === 'string' ? msg.sessionId : undefined,
    typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
    typeof payload.rootSessionId === 'string' ? payload.rootSessionId : undefined,
    typeof payload.parentSessionId === 'string' ? payload.parentSessionId : undefined,
    typeof payload.originalSessionId === 'string' ? payload.originalSessionId : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  // Global events without session hints should still trigger refresh,
  // because context-monitor API is session-scoped and will no-op if unchanged.
  if (hints.length === 0) return true;
  return hints.includes(sessionId);
}

const CONTEXT_MONITOR_TRIGGER_TYPES = new Set<string>([
  'chat_codex_turn',
  'user_message',
  'assistant_complete',
  'tool_call',
  'tool_result',
  'tool_error',
  'workflow_update',
  'agent_update',
  'agent_status',
  'phase_transition',
  'waiting_for_user',
  'session_changed',
  'session_created',
  'session_resumed',
  'session_paused',
  'session_compressed',
  'messageCreated',
  'messageCompleted',
]);

const CONTEXT_PARTITIONS: Array<{
  key: string;
  title: string;
  summary: string;
  mutable?: boolean;
}> = [
  { key: 'P0', title: 'core_instructions', summary: 'system/developer prompts (stable)' },
  { key: 'P1', title: 'runtime_capabilities', summary: 'skills + mailbox + FLOW blocks (stable)' },
  { key: 'P2', title: 'current_turn', summary: 'current user input + attachments (highest priority)' },
  { key: 'P3', title: 'continuity_anchors', summary: 'recent task/user anchors for continuity checks' },
  { key: 'P4', title: 'dynamic_history', summary: 'working_set + historical_memory (rebuild scope)', mutable: true },
  { key: 'P5', title: 'canonical_storage', summary: 'ledger raw timeline + MEMORY.md (truth source)' },
];

const CONTEXT_QUERY_PLAYBOOK = [
  '1) MEMORY.md: durable ground truth only',
  '2) context_ledger.memory search: find slot/task hits',
  '3) context_ledger.memory query(detail=true, slot_start, slot_end): raw evidence',
  '4) context_ledger.expand_task: expand one compact task block',
];

export const ContextMonitor: React.FC<ContextMonitorProps> = ({
  sessionId,
  label = 'Context Builder Monitor',
  liveUpdatesEnabled = true,
  debounceMs = 120,
  externalCommand = null,
}) => {
  const [data, setData] = useState<ContextMonitorResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null);
  const [compareRoundId, setCompareRoundId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ title: string; content: string; meta?: string } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const fetchInFlightRef = useRef(false);
  const queuedRefreshRef = useRef(false);
  const scheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const expandedCardRef = useRef<HTMLDivElement | null>(null);
  const lastHandledExternalCommandRef = useRef<string | null>(null);

  const fetchData = useCallback(async (options?: { silent?: boolean }) => {
    if (!sessionId) return;
    const silent = options?.silent === true;
    if (fetchInFlightRef.current) {
      queuedRefreshRef.current = true;
      return;
    }
    fetchInFlightRef.current = true;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/sessions/${sessionId}/context-monitor?limit=1200`);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`请求失败 ${response.status}: ${text || 'unknown error'}`);
      }
      const payload = await response.json() as ContextMonitorResponse;
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      fetchInFlightRef.current = false;
      if (!silent) setLoading(false);
      if (queuedRefreshRef.current) {
        queuedRefreshRef.current = false;
        void fetchData({ silent: true });
      }
    }
  }, [sessionId]);

  const scheduleRefresh = useCallback((delayMs = 120) => {
    if (scheduleTimerRef.current) return;
    scheduleTimerRef.current = setTimeout(() => {
      scheduleTimerRef.current = null;
      void fetchData({ silent: true });
    }, delayMs);
  }, [fetchData]);

  useEffect(() => {
    setData(null);
    setSelectedRoundId(null);
    setDetail(null);
    fetchInFlightRef.current = false;
    queuedRefreshRef.current = false;
    if (scheduleTimerRef.current) {
      clearTimeout(scheduleTimerRef.current);
      scheduleTimerRef.current = null;
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    void fetchData();
  }, [fetchData, sessionId]);

  useEffect(() => {
    return () => {
      if (scheduleTimerRef.current) {
        clearTimeout(scheduleTimerRef.current);
        scheduleTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  const handleWsMessage = useCallback((msg: WsMessage) => {
    if (!liveUpdatesEnabled) return;
    if (!sessionId) return;
    if (!CONTEXT_MONITOR_TRIGGER_TYPES.has(msg.type)) return;
    if (!isRelevantSessionMessage(msg, sessionId)) return;
    scheduleRefresh(Math.max(40, Math.min(600, debounceMs)));
  }, [debounceMs, liveUpdatesEnabled, scheduleRefresh, sessionId]);

  useWebSocket(handleWsMessage, { disabled: !sessionId || !liveUpdatesEnabled });

  const sortedRounds = useMemo(() => {
    if (!data?.rounds) return [];
    return [...data.rounds].sort((a, b) => b.slotStart - a.slotStart);
  }, [data?.rounds]);

  useEffect(() => {
    if (sortedRounds.length === 0) {
      setSelectedRoundId(null);
      return;
    }
    const hasSelected = selectedRoundId ? sortedRounds.some((round) => round.id === selectedRoundId) : false;
    if (!hasSelected) {
      const first = sortedRounds[0];
      setSelectedRoundId(first.id);
    }
  }, [selectedRoundId, sortedRounds]);

  const selectedRound = useMemo(() => {
    if (!selectedRoundId) return sortedRounds[0] || null;
    return sortedRounds.find((round) => round.id === selectedRoundId) || sortedRounds[0] || null;
  }, [selectedRoundId, sortedRounds]);

  const timelineRounds = useMemo(() => {
    if (!data?.rounds) return [];
    return [...data.rounds].sort((a, b) => a.slotStart - b.slotStart);
  }, [data?.rounds]);

  const selectedRoundTimelineIndex = useMemo(() => {
    if (!selectedRound) return -1;
    return timelineRounds.findIndex((round) => round.id === selectedRound.id);
  }, [selectedRound, timelineRounds]);

  const previousRound = useMemo(() => {
    if (selectedRoundTimelineIndex <= 0) return null;
    return timelineRounds[selectedRoundTimelineIndex - 1] ?? null;
  }, [selectedRoundTimelineIndex, timelineRounds]);

  useEffect(() => {
    setCompareRoundId(previousRound?.id ?? null);
  }, [previousRound?.id, selectedRoundId, sessionId]);

  useEffect(() => {
    if (!expanded) return;
    window.setTimeout(() => {
      expandedCardRef.current?.focus();
    }, 0);
  }, [expanded]);

  const comparisonRound = useMemo(() => {
    if (!selectedRound) return null;
    if (!compareRoundId) return previousRound;
    return timelineRounds.find((round) => round.id === compareRoundId) ?? previousRound;
  }, [compareRoundId, previousRound, selectedRound, timelineRounds]);

  const compareCandidates = useMemo(() => {
    if (!selectedRound) return [];
    return timelineRounds.filter((round) => round.id !== selectedRound.id);
  }, [selectedRound, timelineRounds]);

  const comparisonIndex = useMemo(() => {
    if (!comparisonRound) return -1;
    return compareCandidates.findIndex((round) => round.id === comparisonRound.id);
  }, [compareCandidates, comparisonRound]);

  const stepComparisonRound = useCallback((direction: -1 | 1) => {
    if (compareCandidates.length === 0) return;
    if (comparisonIndex < 0) {
      const fallbackIndex = direction < 0 ? compareCandidates.length - 1 : 0;
      setCompareRoundId(compareCandidates[fallbackIndex]?.id ?? null);
      return;
    }
    const nextIndex = Math.max(0, Math.min(compareCandidates.length - 1, comparisonIndex + direction));
    setCompareRoundId(compareCandidates[nextIndex]?.id ?? null);
  }, [compareCandidates, comparisonIndex]);

  const onCompareKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    const editing = target?.isContentEditable
      || tag === 'input'
      || tag === 'textarea'
      || tag === 'select';
    if (editing) return;
    if (event.key === 'ArrowLeft' || event.key === '[') {
      event.preventDefault();
      stepComparisonRound(-1);
      return;
    }
    if (event.key === 'ArrowRight' || event.key === ']') {
      event.preventDefault();
      stepComparisonRound(1);
    }
  }, [stepComparisonRound]);

  useEffect(() => {
    if (!externalCommand?.id) return;
    if (externalCommand.id === lastHandledExternalCommandRef.current) return;
    lastHandledExternalCommandRef.current = externalCommand.id;
    if (externalCommand.action === 'focus_latest_round') {
      if (sortedRounds.length > 0) {
        setSelectedRoundId(sortedRounds[0].id);
      }
      cardRef.current?.focus();
      expandedCardRef.current?.focus();
      return;
    }
    if (externalCommand.action === 'focus_latest_strategy_change') {
      if (timelineRounds.length > 1) {
        const strategyTagForRound = (round: ContextMonitorRound): string => describeContextStrategy(round).tag;
        let targetIndex = -1;
        for (let idx = timelineRounds.length - 1; idx >= 1; idx -= 1) {
          const current = strategyTagForRound(timelineRounds[idx]);
          const previous = strategyTagForRound(timelineRounds[idx - 1]);
          if (current !== previous) {
            targetIndex = idx;
            break;
          }
        }
        if (targetIndex >= 0) {
          const targetRound = timelineRounds[targetIndex];
          const baseRound = timelineRounds[targetIndex - 1] ?? null;
          setSelectedRoundId(targetRound.id);
          setCompareRoundId(baseRound?.id ?? null);
        } else if (sortedRounds.length > 0) {
          setSelectedRoundId(sortedRounds[0].id);
        }
      } else if (sortedRounds.length > 0) {
        setSelectedRoundId(sortedRounds[0].id);
      }
      cardRef.current?.focus();
      expandedCardRef.current?.focus();
      return;
    }
    if (externalCommand.action === 'step_compare_prev') {
      stepComparisonRound(-1);
      cardRef.current?.focus();
      expandedCardRef.current?.focus();
      return;
    }
    if (externalCommand.action === 'step_compare_next') {
      stepComparisonRound(1);
      cardRef.current?.focus();
      expandedCardRef.current?.focus();
    }
  }, [externalCommand, sortedRounds, stepComparisonRound, timelineRounds]);

  const strategyView = useMemo(() => describeContextStrategy(selectedRound), [selectedRound]);

  const openLedgerDetail = useCallback(async (slot: number) => {
    if (!sessionId) return;
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/v1/sessions/${sessionId}/ledger/${slot}`);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        setDetail({
          title: `Slot #${slot} 详情`,
          content: `读取失败 (${response.status})\n${text || 'unknown error'}`,
        });
        return;
      }
      const payload = await response.json() as { detail?: { content_full?: string; event_type?: string; role?: string; timestamp_iso?: string } };
      const detailPayload = payload.detail;
      setDetail({
        title: `Slot #${slot} · ${detailPayload?.event_type || 'entry'}`,
        content: detailPayload?.content_full || '无内容',
        meta: `${detailPayload?.role || '-'} · ${detailPayload?.timestamp_iso || ''}`,
      });
    } catch (err) {
      setDetail({
        title: `Slot #${slot} 详情`,
        content: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDetailLoading(false);
    }
  }, [sessionId]);

  const openContextMessageDetail = useCallback((message: ContextMonitorMessage) => {
    setDetail({
      title: `Context 消息 · ${roleLabel(message.role)}${typeof message.slot === 'number' ? ` · slot ${message.slot}` : ''}`,
      content: message.content,
      meta: `${message.timestampIso} · ${message.tokenCount} tok`,
    });
  }, []);

  const selectedSlots = useMemo(() => {
    return collectRoundContextSlots(selectedRound);
  }, [selectedRound]);
  const selectedContextCount = selectedRound?.contextMessages.length ?? 0;
  const selectedLedgerCount = selectedSlots.size;

  const compareSlots = useMemo(() => collectRoundContextSlots(comparisonRound), [comparisonRound]);
  const comparisonDiff = useMemo(() => {
    const added = Array.from(selectedSlots).filter((slot) => !compareSlots.has(slot)).sort((a, b) => a - b);
    const removed = Array.from(compareSlots).filter((slot) => !selectedSlots.has(slot)).sort((a, b) => a - b);
    const unchanged = Array.from(selectedSlots).filter((slot) => compareSlots.has(slot)).sort((a, b) => a - b);
    return { added, removed, unchanged };
  }, [compareSlots, selectedSlots]);

  const metricDelta = useMemo(() => {
    const current = selectedRound?.modelSummary;
    const baseline = comparisonRound?.modelSummary;
    if (!current || !baseline) return null;
    const numberDelta = (a: unknown, b: unknown): number | undefined => {
      const av = toNumber(a);
      const bv = toNumber(b);
      if (av === undefined || bv === undefined) return undefined;
      return av - bv;
    };
    return {
      historyItemsCount: numberDelta(current.historyItemsCount, baseline.historyItemsCount),
      contextTokensInWindow: numberDelta(current.contextTokensInWindow, baseline.contextTokensInWindow),
      contextUsagePercent: numberDelta(current.contextUsagePercent, baseline.contextUsagePercent),
      totalTokens: numberDelta(current.totalTokens, baseline.totalTokens),
    };
  }, [comparisonRound, selectedRound]);

  const traceBackRows = useMemo(() => {
    if (!selectedRound || selectedRoundTimelineIndex <= 0) return [];
    const currentSlots = collectRoundContextSlots(selectedRound);
    const rows: Array<{
      round: ContextMonitorRound;
      addedCount: number;
      removedCount: number;
      overlapCount: number;
      tokenDelta?: number;
      historyDelta?: number;
    }> = [];
    for (let idx = selectedRoundTimelineIndex - 1; idx >= 0; idx -= 1) {
      const base = timelineRounds[idx];
      const baseSlots = collectRoundContextSlots(base);
      const addedCount = Array.from(currentSlots).filter((slot) => !baseSlots.has(slot)).length;
      const removedCount = Array.from(baseSlots).filter((slot) => !currentSlots.has(slot)).length;
      const overlapCount = Array.from(currentSlots).filter((slot) => baseSlots.has(slot)).length;
      const tokenDelta = toNumber(selectedRound.modelSummary?.contextTokensInWindow) !== undefined
        && toNumber(base.modelSummary?.contextTokensInWindow) !== undefined
        ? Number(toNumber(selectedRound.modelSummary?.contextTokensInWindow)) - Number(toNumber(base.modelSummary?.contextTokensInWindow))
        : undefined;
      const historyDelta = toNumber(selectedRound.modelSummary?.historyItemsCount) !== undefined
        && toNumber(base.modelSummary?.historyItemsCount) !== undefined
        ? Number(toNumber(selectedRound.modelSummary?.historyItemsCount)) - Number(toNumber(base.modelSummary?.historyItemsCount))
        : undefined;
      rows.push({
        round: base,
        addedCount,
        removedCount,
        overlapCount,
        tokenDelta,
        historyDelta,
      });
    }
    return rows;
  }, [selectedRound, selectedRoundTimelineIndex, timelineRounds]);

  const renderMonitorCard = (options?: { expandedView?: boolean; cardRef?: React.RefObject<HTMLDivElement> }) => (
    <div
      ref={options?.cardRef}
      className={`context-monitor-card${options?.expandedView ? ' context-monitor-card-expanded' : ''}`}
      tabIndex={0}
      onKeyDown={onCompareKeyDown}
    >
      <div className="context-monitor-header">
        <div className="context-monitor-title-row">
          <div className="context-monitor-title">{label}</div>
          <div className="context-monitor-actions">
            {!options?.expandedView && (
              <button
                type="button"
                className="context-monitor-expand-btn"
                onClick={() => { setExpanded(true); }}
                title="展开为大视图"
              >
                展开
              </button>
            )}
            {options?.expandedView && (
              <button
                type="button"
                className="context-monitor-expand-btn close"
                onClick={() => { setExpanded(false); }}
                title="关闭大视图"
              >
                关闭
              </button>
            )}
          </div>
        </div>
        <div className="context-monitor-meta">
          <span>session: {sessionId || '—'}</span>
          <span>rounds: {sortedRounds.length}</span>
          {data?.contextBuild?.ok && <span>ctx: {data.contextBuild.totalTokens || 0} tok</span>}
          {data?.contextBuilder?.historyBudgetTokens != null && (
            <span>histBudget:{data.contextBuilder.historyBudgetTokens}</span>
          )}
          {data?.contextBuilder?.historyOnly !== false && <span>history-only</span>}
          {data?.contextBuilder?.enableModelRanking && typeof data.contextBuilder.enableModelRanking === 'string' && (
            <span className="context-ranking-badge" title="dryrun 模式：排序已执行但未重排上下文">
              ranking:{data.contextBuilder.enableModelRanking}
            </span>
          )}
          {data?.contextBuilder?.enableModelRanking === true && (
            <span className="context-ranking-badge context-ranking-active" title="active 模式：排序结果已应用">
              ranking:active
            </span>
          )}
          {data?.contextBuilder?.rankingProviderId && (
            <span>provider:{data.contextBuilder.rankingProviderId}</span>
          )}
          {data?.contextBuilder?.mode && (
            <span className="context-mode-badge">mode:{data.contextBuilder.mode}</span>
          )}
          {data?.contextBuild?.metadata?.removedIrrelevantCount != null && data.contextBuild.metadata.removedIrrelevantCount > 0 && (
            <span title="移除的无关 task">removed:{data.contextBuild.metadata.removedIrrelevantCount}</span>
          )}
          {data?.contextBuild?.metadata?.supplementedCount != null && data.contextBuild.metadata.supplementedCount > 0 && (
            <span title="补充的历史 task">+{data.contextBuild.metadata.supplementedCount}</span>
          )}
          {data?.contextBuild?.metadata?.budgetTruncatedCount != null && data.contextBuild.metadata.budgetTruncatedCount > 0 && (
            <span title="因预算被截断的 task">cut:{data.contextBuild.metadata.budgetTruncatedCount}</span>
          )}
          {data?.contextBuild?.metadata?.workingSetMessageCount != null && (
            <span title="本轮推理区消息数">
              ws:{data.contextBuild.metadata.workingSetMessageCount}/{data.contextBuild.metadata.workingSetTokens ?? 0}tok
            </span>
          )}
          {data?.contextBuild?.metadata?.historicalMessageCount != null && (
            <span title="历史记忆区消息数">
              hist:{data.contextBuild.metadata.historicalMessageCount}/{data.contextBuild.metadata.historicalTokens ?? 0}tok
            </span>
          )}
          <span>{liveUpdatesEnabled ? 'live:on' : 'live:off'}</span>
          <span>{loading ? '刷新中…' : `更新 ${data?.updatedAt ? formatTimestamp(data.updatedAt) : '--:--:--'}`}</span>
        </div>
        <div className="context-monitor-flow">
          <span>① 选 Round</span>
          <span>② 看该 Round 的 Selected Context 组合</span>
          <span>③ 右侧对照原始 Ledger（已选/未选）</span>
          <span>④ 对比上一轮变化 + 回溯</span>
          <span>⑤ 点击任意行看详情</span>
        </div>
        <div className="context-partition-legend">
          <div className="context-partition-title">
            Context Partitions（重建仅允许改写 P4）
          </div>
          <div className="context-partition-grid">
            {CONTEXT_PARTITIONS.map((partition) => (
              <div
                key={partition.key}
                className={`context-partition-chip${partition.mutable ? ' mutable' : ''}`}
                title={partition.summary}
              >
                <span className="partition-key">{partition.key}</span>
                <span className="partition-name">{partition.title}</span>
                <span className="partition-summary">{partition.summary}</span>
              </div>
            ))}
          </div>
          <div className="context-query-playbook">
            {CONTEXT_QUERY_PLAYBOOK.map((step) => (
              <span key={step} className="query-step">{step}</span>
            ))}
          </div>
        </div>
        <div className="context-monitor-insight">
          <div className={`context-strategy-chip tone-${strategyView.tone}`} title={strategyView.detail}>
            本轮策略：{strategyView.tag}
          </div>
          <div className="context-insight-line">
            {selectedRound?.contextStrategy?.derivedFromSlot != null
              ? `策略来源 slot #${selectedRound.contextStrategy.derivedFromSlot} (${selectedRound.contextStrategy.derivedFromEventType || 'event'})`
              : '策略来源：未记录'}
          </div>
          <div className="context-insight-line">
            基线：
            <select
              className="context-compare-select"
              value={compareRoundId ?? ''}
              onChange={(event) => { setCompareRoundId(event.target.value); }}
            >
              <option value="">上一轮（默认）</option>
              {compareCandidates.map((round) => (
                <option key={round.id} value={round.id}>
                  #{round.slotStart}-{round.slotEnd} {formatTimestamp(round.startTimeIso)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="context-compare-nav"
              onClick={() => { stepComparisonRound(-1); }}
              disabled={compareCandidates.length === 0 || comparisonIndex <= 0}
              title="向前回溯一个基线（快捷键：← / [）"
            >
              ← 前一基线
            </button>
            <button
              type="button"
              className="context-compare-nav"
              onClick={() => { stepComparisonRound(1); }}
              disabled={compareCandidates.length === 0 || comparisonIndex >= compareCandidates.length - 1}
              title="向后回溯一个基线（快捷键：→ / ]）"
            >
              后一基线 →
            </button>
            <span className="context-insight-muted">
              {comparisonRound ? `对比 #${comparisonRound.slotStart}-${comparisonRound.slotEnd}` : '无可对比轮次'}
            </span>
            <span className="context-key-hint">快捷键：←/→ 或 [/]</span>
          </div>
          {Array.isArray(data?.contextBuild?.metadata?.budgetTruncatedTasks)
            && data.contextBuild.metadata.budgetTruncatedTasks.length > 0 && (
            <div className="context-insight-line">
              预算截断：
              {data.contextBuild.metadata.budgetTruncatedTasks.slice(0, 3).map((task) => (
                <span key={task.id} style={{ marginLeft: 8 }}>
                  [{task.id} · {task.tokenCount}tok]
                </span>
              ))}
              {data.contextBuild.metadata.budgetTruncatedTasks.length > 3 && (
                <span style={{ marginLeft: 8 }}>
                  +{data.contextBuild.metadata.budgetTruncatedTasks.length - 3}
                </span>
              )}
            </div>
          )}
          <div className="context-insight-diff">
            <span className="diff-added">+{comparisonDiff.added.length}</span>
            <span className="diff-removed">-{comparisonDiff.removed.length}</span>
            <span className="diff-same">={comparisonDiff.unchanged.length}</span>
            {metricDelta?.historyItemsCount !== undefined && (
              <span>history Δ {metricDelta.historyItemsCount > 0 ? '+' : ''}{metricDelta.historyItemsCount}</span>
            )}
            {metricDelta?.contextTokensInWindow !== undefined && (
              <span>ctxTok Δ {metricDelta.contextTokensInWindow > 0 ? '+' : ''}{metricDelta.contextTokensInWindow}</span>
            )}
            {metricDelta?.contextUsagePercent !== undefined && (
              <span>usage Δ {metricDelta.contextUsagePercent > 0 ? '+' : ''}{metricDelta.contextUsagePercent}%</span>
            )}
          </div>
          {(comparisonDiff.added.length > 0 || comparisonDiff.removed.length > 0) && (
            <div className="context-insight-slot-groups">
              {comparisonDiff.added.length > 0 && (
                <div className="slot-group">
                  <span className="slot-group-title">新增命中</span>
                  <div className="slot-pills">
                    {comparisonDiff.added.map((slot) => (
                      <button key={`add-${slot}`} type="button" className="slot-pill add" onClick={() => { void openLedgerDetail(slot); }}>
                        #{slot}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {comparisonDiff.removed.length > 0 && (
                <div className="slot-group">
                  <span className="slot-group-title">移出命中</span>
                  <div className="slot-pills">
                    {comparisonDiff.removed.map((slot) => (
                      <button key={`rm-${slot}`} type="button" className="slot-pill remove" onClick={() => { void openLedgerDetail(slot); }}>
                        #{slot}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {traceBackRows.length > 0 && (
            <div className="context-traceback">
              <span className="context-traceback-title">回溯变化</span>
              <div className="context-traceback-list">
                {traceBackRows.slice(0, 8).map((row) => (
                  <button
                    key={`trace-${row.round.id}`}
                    type="button"
                    className={`traceback-row ${comparisonRound?.id === row.round.id ? 'active' : ''}`}
                    onClick={() => { setCompareRoundId(row.round.id); }}
                    title="点击设置为对比基线"
                  >
                    <span className="traceback-round">#{row.round.slotStart}-{row.round.slotEnd}</span>
                    <span className="traceback-diff">+{row.addedCount} / -{row.removedCount} / ={row.overlapCount}</span>
                    <span className="traceback-metric">
                      {row.historyDelta !== undefined ? `history ${row.historyDelta > 0 ? '+' : ''}${row.historyDelta}` : 'history -'}
                    </span>
                    <span className="traceback-metric">
                      {row.tokenDelta !== undefined ? `ctxTok ${row.tokenDelta > 0 ? '+' : ''}${row.tokenDelta}` : 'ctxTok -'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {error && <div className="context-monitor-error">{error}</div>}
      {!error && !sessionId && <div className="context-monitor-empty">未选择会话</div>}

      {!error && sessionId && (
        <div className="context-monitor-body">
          <div className="context-monitor-pane context-monitor-pane-left">
            <div className="context-pane-title">
              ① Round 列表（最小选择单元）
              {selectedRound && <span className="context-pane-subtitle">当前 #{selectedRound.slotStart}-{selectedRound.slotEnd}</span>}
            </div>
            <div className="context-round-list">
              {sortedRounds.length === 0 && <div className="context-monitor-empty">暂无 round 数据</div>}
              {sortedRounds.map((round) => {
                const selected = selectedRound?.id === round.id;
                return (
                  <div
                    key={round.id}
                    className={`context-round-item ${selected ? 'selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="context-round-header"
                      onClick={() => {
                        setSelectedRoundId(round.id);
                      }}
                    >
                      <span className="round-slot">#{round.slotStart}-{round.slotEnd}</span>
                      <span className="round-time">{formatTimestamp(round.startTimeIso)} → {formatTimestamp(round.endTimeIso)}</span>
                      <span className="round-finish">{round.finishReason || '-'}</span>
                      <span className="round-count">{round.contextMessages.length}/{round.events.length}</span>
                    </button>
                    <div className="context-round-prompt">{shorten(round.userPrompt || '（无用户输入）', 120)}</div>
                  </div>
                );
              })}
            </div>

            <div className="context-pane-title">
              ② Selected Context 组合（仅本 Round）
              {selectedRound && <span className="context-pane-subtitle">{selectedContextCount} 条</span>}
            </div>
            <div className="context-message-list">
              {!selectedRound && <div className="context-monitor-empty">请选择一个 round</div>}
              {selectedRound && selectedRound.contextMessages.length === 0 && (
                <div className="context-monitor-empty">该 round 没有被 context builder 选中消息</div>
              )}
              {selectedRound?.contextMessages.map((message) => (
                <button
                  key={message.id}
                  type="button"
                  className="context-message-item"
                  onClick={() => openContextMessageDetail(message)}
                  title="点击查看完整内容"
                >
                  <span className="context-message-role">{roleLabel(message.role)}</span>
                  <span className={`context-message-slot ${message.contextZone === 'working_set' ? 'zone-working' : 'zone-history'}`}>
                    {contextZoneLabel(message.contextZone)}
                  </span>
                  <span className="context-message-slot">{typeof message.slot === 'number' ? `#${message.slot}` : '#-'}</span>
                  <span className="context-message-preview">{shorten(message.content, 120)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="context-monitor-pane context-monitor-pane-right">
            <div className="context-pane-title">
              ③ Round Ledger 对照（原始事件）
              {selectedRound && <span className="context-pane-subtitle">round #{selectedRound.slotStart}-{selectedRound.slotEnd} · 命中 {selectedLedgerCount} 条</span>}
            </div>
            <div className="context-ledger-list">
              {!selectedRound && <div className="context-monitor-empty">请选择一个 round</div>}
              {selectedRound?.events.map((event) => {
                const hit = selectedSlots.has(event.slot);
                const compareHit = compareSlots.has(event.slot);
                const deltaState: 'added' | 'removed' | 'same' | 'none' = hit && !compareHit
                  ? 'added'
                  : (!hit && compareHit
                    ? 'removed'
                    : (hit && compareHit ? 'same' : 'none'));
                const deltaLabel = deltaState === 'added'
                  ? '新增'
                  : (deltaState === 'removed'
                    ? '移出'
                    : (deltaState === 'same' ? '保留' : '未选'));
                return (
                  <button
                    key={`${event.id}-${event.slot}`}
                    type="button"
                    className={`context-ledger-item ${hit ? 'selected' : ''} ${deltaState !== 'none' ? `delta-${deltaState}` : ''}`}
                    onClick={() => { void openLedgerDetail(event.slot); }}
                    title="点击查看原始消息"
                  >
                    <span className="ledger-slot">#{event.slot}</span>
                    <span className="ledger-event">{eventLabel(event.eventType)}</span>
                    <span className="ledger-role">{roleLabel(event.role || '-')}</span>
                    <span className="ledger-time">{formatTimestamp(event.timestampIso)}</span>
                    <span className={`ledger-hit ${deltaState}`}>{deltaLabel}</span>
                    <span className="ledger-preview">{shorten(event.preview, 100)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="context-monitor-detail">
        <div className="context-detail-header">
          <span>④ 详情（点击左/右任意行打开）</span>
          {detailLoading && <span className="context-detail-loading">加载中…</span>}
        </div>
        {!detail && !detailLoading && <div className="context-monitor-empty">点击左侧 context 消息或右侧 ledger 事件查看详情</div>}
        {detail && !detailLoading && (
          <div className="context-detail-content">
            <div className="context-detail-title">{detail.title}</div>
            {detail.meta && <div className="context-detail-meta">{detail.meta}</div>}
            <pre className="context-detail-pre">{detail.content}</pre>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {renderMonitorCard({ cardRef })}
      {expanded && typeof document !== 'undefined' && createPortal(
        <div className="context-monitor-overlay" onClick={() => { setExpanded(false); }}>
          <div className="context-monitor-modal" onClick={(event) => { event.stopPropagation(); }}>
            {renderMonitorCard({ expandedView: true, cardRef: expandedCardRef })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

export default ContextMonitor;
