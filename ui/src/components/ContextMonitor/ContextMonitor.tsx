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
}

interface ContextMonitorRound {
  id: string;
  slotStart: number;
  slotEnd: number;
  startTimeIso: string;
  endTimeIso: string;
  userPrompt: string;
  finishReason?: string;
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
      targetBudget: number;
      actualTokens: number;
      buildMode?: string;
      removedIrrelevantCount?: number;
      supplementedCount?: number;
      removedTokens?: number;
      supplementedTokens?: number;
    };
    messages: Array<{
      id: string;
      role: string;
      content: string;
      timestampIso: string;
      tokenCount: number;
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

export const ContextMonitor: React.FC<ContextMonitorProps> = ({
  sessionId,
  label = 'Context Builder Monitor',
  liveUpdatesEnabled = true,
  debounceMs = 120,
}) => {
  const [data, setData] = useState<ContextMonitorResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ title: string; content: string; meta?: string } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const fetchInFlightRef = useRef(false);
  const queuedRefreshRef = useRef(false);
  const scheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (!selectedRound) return new Set<number>();
    const slots = selectedRound.contextMessages
      .map((msg) => msg.slot)
      .filter((slot): slot is number => typeof slot === 'number' && Number.isFinite(slot));
    return new Set(slots);
  }, [selectedRound]);
  const selectedContextCount = selectedRound?.contextMessages.length ?? 0;
  const selectedLedgerCount = selectedSlots.size;

  const renderMonitorCard = (options?: { expandedView?: boolean }) => (
    <div className={`context-monitor-card${options?.expandedView ? ' context-monitor-card-expanded' : ''}`}>
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
          <span>{liveUpdatesEnabled ? 'live:on' : 'live:off'}</span>
          <span>{loading ? '刷新中…' : `更新 ${data?.updatedAt ? formatTimestamp(data.updatedAt) : '--:--:--'}`}</span>
        </div>
        <div className="context-monitor-flow">
          <span>① 选 Round</span>
          <span>② 看该 Round 的 Selected Context 组合</span>
          <span>③ 右侧对照原始 Ledger（已选/未选）</span>
          <span>④ 点击任意行看详情</span>
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
                return (
                  <button
                    key={`${event.id}-${event.slot}`}
                    type="button"
                    className={`context-ledger-item ${hit ? 'selected' : ''}`}
                    onClick={() => { void openLedgerDetail(event.slot); }}
                    title="点击查看原始消息"
                  >
                    <span className="ledger-slot">#{event.slot}</span>
                    <span className="ledger-event">{eventLabel(event.eventType)}</span>
                    <span className="ledger-role">{roleLabel(event.role || '-')}</span>
                    <span className="ledger-time">{formatTimestamp(event.timestampIso)}</span>
                    <span className={`ledger-hit ${hit ? 'yes' : 'no'}`}>{hit ? '已选' : '未选'}</span>
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
      {renderMonitorCard()}
      {expanded && typeof document !== 'undefined' && createPortal(
        <div className="context-monitor-overlay" onClick={() => { setExpanded(false); }}>
          <div className="context-monitor-modal" onClick={(event) => { event.stopPropagation(); }}>
            {renderMonitorCard({ expandedView: true })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

export default ContextMonitor;
