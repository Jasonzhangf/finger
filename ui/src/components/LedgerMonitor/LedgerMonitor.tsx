import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useWebSocket } from '../../hooks/useWebSocket.js';
import type { WsMessage } from '../../api/types.js';
import './LedgerMonitor.css';

interface LedgerSlot {
  slot: number;
  id: string;
  timestamp_iso: string;
  event_type: string;
  agent_id: string;
  role: string;
  content_preview: string;
}

interface SessionMeta {
  id: string;
  name: string;
  projectPath: string;
  totalTokens: number;
  originalStartIndex: number;
  originalEndIndex: number;
  latestCompactIndex: number;
}

interface LedgerSlotDetail {
  slot: number;
  id: string;
  timestamp_ms: number;
  timestamp_iso: string;
  event_type: string;
  agent_id: string;
  mode: string;
  role: string;
  content_preview: string;
  content_full: string;
  payload: Record<string, unknown>;
  raw_entry: Record<string, unknown>;
}

interface LedgerApiResponse {
  success?: boolean;
  total?: number;
  offset?: number;
  limit?: number;
  slots?: LedgerSlot[];
  compactCount?: number;
  sessionMeta?: SessionMeta | null;
  error?: string;
}

interface LedgerFetchResult {
  ok: boolean;
  sessionId: string;
  data?: LedgerApiResponse;
  status?: number;
  error?: string;
}

interface LedgerDetailResponse {
  success?: boolean;
  sessionId?: string;
  slot?: number;
  detail?: LedgerSlotDetail;
  error?: string;
}

interface LedgerMonitorProps {
  sessionId?: string;
  label?: string;
  onClick?: () => void;
  liveUpdatesEnabled?: boolean;
  debounceMs?: number;
}

interface LedgerModalProps {
  sessionId: string;
  label?: string;
  onClose: () => void;
}

function formatTimestamp(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function eventTypeLabel(type: string): string {
  if (type === 'session_message') return '消息';
  if (type === 'context_compact') return '压缩';
  if (type === 'focus_insert') return '焦点';
  if (type === 'tool_call' || type === 'tool_result') return '工具';
  if (type === 'dispatch') return '派发';
  if (type === 'turn_start') return '轮次开始';
  if (type === 'turn_complete') return '轮次完成';
  return type;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRelevantSessionMessage(msg: WsMessage, sessionId: string): boolean {
  const payload = isRecord(msg.payload) ? msg.payload : {};
  const eventSessionId = typeof msg.sessionId === 'string'
    ? msg.sessionId
    : (typeof payload.sessionId === 'string' ? payload.sessionId : undefined);
  if (eventSessionId === sessionId) return true;
  if (typeof payload.rootSessionId === 'string' && payload.rootSessionId === sessionId) return true;
  if (typeof payload.parentSessionId === 'string' && payload.parentSessionId === sessionId) return true;
  if (typeof payload.originalSessionId === 'string' && payload.originalSessionId === sessionId) return true;
  return false;
}

const LEDGER_MONITOR_TRIGGER_TYPES = new Set<string>([
  'assistant_complete',
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
]);

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: string; message?: string };
    if (payload?.error) return payload.error;
    if (payload?.message) return payload.message;
  } catch {
    // ignore json parse failure
  }
  try {
    const text = await response.text();
    if (text.trim().length > 0) return text.trim();
  } catch {
    // ignore text parse failure
  }
  return 'unknown error';
}

async function fetchLedgerPage(sessionId: string, limit: number, offset: number, signal?: AbortSignal): Promise<LedgerFetchResult> {
  const res = await fetch(`/api/v1/sessions/${sessionId}/ledger?limit=${limit}&offset=${offset}`, { signal });
  if (res.ok) {
    const data = await res.json() as LedgerApiResponse;
    return { ok: true, sessionId, data };
  }
  const reason = await readErrorMessage(res);
  return {
    ok: false,
    sessionId,
    status: res.status,
    error: `请求失败 ${res.status}: ${reason}`,
  };
}

const PAGE_SIZE = 500;
const CARD_PREVIEW_LIMIT = 500;

const LedgerModal: React.FC<LedgerModalProps> = ({ sessionId, label, onClose }) => {
  const [slots, setSlots] = useState<LedgerSlot[]>([]);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [jumpSlot, setJumpSlot] = useState('');
  const [activeSessionId, setActiveSessionId] = useState(sessionId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<LedgerSlotDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const slotListRef = useRef<HTMLDivElement | null>(null);

  const fetchLedger = useCallback(async (newOffset: number, requestedSessionId?: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const targetSessionId = requestedSessionId || activeSessionId || sessionId;
      const result = await fetchLedgerPage(targetSessionId, PAGE_SIZE, newOffset);
      if (!result.ok || !result.data) {
        setSlots([]);
        setMeta(null);
        setTotal(0);
        setLoadError(result.error || 'ledger 请求失败');
        return;
      }
      setActiveSessionId(result.sessionId);
      setSlots(result.data.slots || []);
      setMeta(result.data.sessionMeta || null);
      setTotal(result.data.total || 0);
      setOffset(newOffset);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('aborted')) {
        return;
      }
      setLoadError(`ledger 请求异常: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [activeSessionId, sessionId]);

  useEffect(() => {
    setActiveSessionId(sessionId);
    setLoadError(null);
    setOffset(0);
    setJumpSlot('');
    void fetchLedger(0, sessionId);
  }, [sessionId, fetchLedger]);

  const handleJump = () => {
    const slotNum = parseInt(jumpSlot, 10);
    if (!Number.isFinite(slotNum) || slotNum < 1) return;
    fetchLedger(Math.max(0, slotNum - 1));
    setJumpSlot('');
  };

  const handleOpenDetail = useCallback(async (slot: number) => {
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/v1/sessions/${activeSessionId}/ledger/${slot}`);
      if (!res.ok) {
        const reason = await readErrorMessage(res);
        setDetailError(`读取原始消息失败 ${res.status}: ${reason}`);
        return;
      }
      const data = await res.json() as LedgerDetailResponse;
      if (!data.detail) {
        setDetailError('未返回原始消息内容');
        return;
      }
      setDetail(data.detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDetailError(`读取原始消息异常: ${message}`);
    } finally {
      setDetailLoading(false);
    }
  }, [activeSessionId]);

  const modalContent = (
    <>
      <div className="ledger-modal-overlay" onClick={onClose}>
        <div className="ledger-modal" onClick={(e) => e.stopPropagation()}>
          <div className="ledger-modal-header">
            <h3>{label || sessionId}</h3>
            <button className="ledger-modal-close" onClick={onClose}>✕</button>
          </div>
          <div className="ledger-meta-bar">
            <span>session: {activeSessionId}</span>
            {loadError && <span className="ledger-error-text">{loadError}</span>}
          </div>
          {meta && (
            <div className="ledger-meta-bar">
              <span>总条目: {total}</span>
              <span>Tokens: {formatTokenCount(meta.totalTokens)}</span>
              <span>指针: [{meta.originalStartIndex}..{meta.originalEndIndex}]</span>
              <span>压缩块: {meta.latestCompactIndex + 1}</span>
              <span>偏移: {offset + 1}..{Math.min(offset + PAGE_SIZE, total)}</span>
            </div>
          )}
          <div className="ledger-jump-bar">
            <span>跳转到 Slot#</span>
            <input type="number" min={1} max={total} value={jumpSlot}
              onChange={(e) => setJumpSlot(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJump()}
              placeholder="1" />
            <button onClick={handleJump}>跳转</button>
            <div className="ledger-pager">
              <button disabled={offset === 0} onClick={() => fetchLedger(Math.max(0, offset - PAGE_SIZE))}>上一页</button>
              <button disabled={offset + PAGE_SIZE >= total} onClick={() => fetchLedger(offset + PAGE_SIZE)}>下一页</button>
            </div>
            <span className="ledger-row-tip">双击列表项查看原始消息</span>
          </div>
          <div ref={slotListRef} className="ledger-slot-list">
            {loading ? (
              <div className="ledger-loading">加载中...</div>
            ) : loadError && slots.length === 0 ? (
              <div className="ledger-empty ledger-error-text">{loadError}</div>
            ) : slots.length === 0 ? (
              <div className="ledger-empty">暂无 ledger 数据</div>
            ) : slots.map((slot) => (
              <div
                key={slot.id || slot.slot}
                className="ledger-slot-item"
                onDoubleClick={() => { void handleOpenDetail(slot.slot); }}
                title="双击查看原始消息"
              >
                <span className="slot-number">#{slot.slot}</span>
                <span className="slot-type">{eventTypeLabel(slot.event_type)}</span>
                <span className="slot-role">{slot.role}</span>
                <span className="slot-time">{formatTimestamp(slot.timestamp_iso)}</span>
                <span className="slot-preview">{slot.content_preview}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
  
      {(detailLoading || detail || detailError) && typeof document !== 'undefined' && createPortal(
        <div className="ledger-detail-overlay" onClick={() => { setDetail(null); setDetailError(null); setDetailLoading(false); }}>
          <div className="ledger-detail-modal" onClick={(event) => event.stopPropagation()}>
            <div className="ledger-detail-header">
              <h4>Ledger 原始消息</h4>
              <button className="ledger-modal-close" onClick={() => { setDetail(null); setDetailError(null); setDetailLoading(false); }}>✕</button>
            </div>
            {detailLoading ? (
              <div className="ledger-loading">加载原始内容...</div>
            ) : detailError ? (
              <div className="ledger-empty ledger-error-text">{detailError}</div>
            ) : detail ? (
              <div className="ledger-detail-body">
                <div className="ledger-detail-meta">
                  <span>slot #{detail.slot}</span>
                  <span>{eventTypeLabel(detail.event_type)}</span>
                  <span>{formatTimestamp(detail.timestamp_iso)}</span>
                </div>
                <pre className="ledger-detail-content">{detail.content_full}</pre>
              </div>
            ) : null}
          </div>
        </div>,
        document.body
      )}
    </>
  );

  if (typeof document !== 'undefined') {
    return createPortal(modalContent, document.body);
  }
  return modalContent;
};

export const LedgerMonitor: React.FC<LedgerMonitorProps> = ({
  sessionId,
  label,
  liveUpdatesEnabled = true,
  debounceMs = 120,
}) => {
  const [latestSlots, setLatestSlots] = useState<LedgerSlot[]>([]);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [resolvedSessionId, setResolvedSessionId] = useState(sessionId || '');
  const [loadError, setLoadError] = useState<string | null>(null);
  const fetchInFlightRef = useRef(false);
  const queuedRefreshRef = useRef(false);
  const scheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadLedgerPreview = useCallback(async () => {
    if (!sessionId) return;
    if (fetchInFlightRef.current) {
      queuedRefreshRef.current = true;
      return;
    }
    fetchInFlightRef.current = true;
    const controller = new AbortController();
    try {
      const result = await fetchLedgerPage(sessionId, CARD_PREVIEW_LIMIT, 0, controller.signal);
      if (!result.ok || !result.data) {
        setLatestSlots([]);
        setMeta(null);
        setLoadError(result.error || 'ledger 请求失败');
        return;
      }
      setResolvedSessionId(result.sessionId);
      setLatestSlots((result.data.slots || []).reverse());
      setMeta(result.data.sessionMeta || null);
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('aborted')) {
        return;
      }
      setLoadError(`ledger 请求异常: ${message}`);
    } finally {
      controller.abort();
      fetchInFlightRef.current = false;
      if (queuedRefreshRef.current) {
        queuedRefreshRef.current = false;
        void loadLedgerPreview();
      }
    }
  }, [sessionId]);

  const scheduleRefresh = useCallback((delayMs = 120) => {
    if (scheduleTimerRef.current) return;
    scheduleTimerRef.current = setTimeout(() => {
      scheduleTimerRef.current = null;
      void loadLedgerPreview();
    }, delayMs);
  }, [loadLedgerPreview]);

  useEffect(() => {
    if (!sessionId) {
      setLatestSlots([]);
      setMeta(null);
      setResolvedSessionId('');
      return;
    }
    setResolvedSessionId(sessionId);
    setLoadError(null);
    void loadLedgerPreview();
    return () => {
      fetchInFlightRef.current = false;
      queuedRefreshRef.current = false;
      if (scheduleTimerRef.current) {
        clearTimeout(scheduleTimerRef.current);
        scheduleTimerRef.current = null;
      }
    };
  }, [loadLedgerPreview, sessionId]);

  const handleWsMessage = useCallback((msg: WsMessage) => {
    if (!liveUpdatesEnabled) return;
    if (!sessionId) return;
    if (!LEDGER_MONITOR_TRIGGER_TYPES.has(msg.type)) return;
    if (!isRelevantSessionMessage(msg, sessionId)) return;
    scheduleRefresh(Math.max(40, Math.min(600, debounceMs)));
  }, [debounceMs, liveUpdatesEnabled, scheduleRefresh, sessionId]);

  useWebSocket(handleWsMessage, { disabled: !sessionId || !liveUpdatesEnabled });

  const title = label || sessionId || '—';

  return (
    <>
      <div className="ledger-monitor-card" onClick={() => setShowModal(true)}>
        <div className="ledger-monitor-title">{title}</div>
        <div className="ledger-monitor-session">
          session {resolvedSessionId || '—'}
          {sessionId && resolvedSessionId && sessionId !== resolvedSessionId ? ` ← ${sessionId}` : ''}
        </div>
        {meta && (
          <div className="ledger-monitor-stats">
            <span>{formatTokenCount(meta.totalTokens)} tok</span>
            <span>{meta.originalEndIndex} entries</span>
            <span>{meta.latestCompactIndex + 1} compact</span>
          </div>
        )}
        <div className="ledger-monitor-recent">
          <div className="ledger-monitor-hint">当前展示 {latestSlots.length} 条（点击查看全部） · live:{liveUpdatesEnabled ? 'on' : 'off'}</div>
          {loadError ? (
            <span className="ledger-monitor-empty ledger-error-text">{loadError}</span>
          ) : latestSlots.length === 0 ? (
            <span className="ledger-monitor-empty">暂无数据</span>
          ) : latestSlots.map((slot) => (
            <div key={slot.id || slot.slot} className="ledger-monitor-entry">
              <span className="entry-type">{eventTypeLabel(slot.event_type)}</span>
              <span className="entry-preview">{slot.content_preview.slice(0, 60)}</span>
            </div>
          ))}
        </div>
      </div>
      {showModal && resolvedSessionId && (
        <LedgerModal sessionId={resolvedSessionId} label={title} onClose={() => setShowModal(false)} />
      )}

    </>
  );
};

export default LedgerMonitor;
