import React, { useState, useEffect, useCallback } from 'react';
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

interface LedgerMonitorProps {
  sessionId?: string;
  label?: string;
  onClick?: () => void;
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

const PAGE_SIZE = 50;

const LedgerModal: React.FC<LedgerModalProps> = ({ sessionId, label, onClose }) => {
  const [slots, setSlots] = useState<LedgerSlot[]>([]);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [jumpSlot, setJumpSlot] = useState('');
  const [activeSessionId, setActiveSessionId] = useState(sessionId);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  return (
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
        </div>
        <div className="ledger-slot-list">
          {loading ? (
            <div className="ledger-loading">加载中...</div>
          ) : loadError && slots.length === 0 ? (
            <div className="ledger-empty ledger-error-text">{loadError}</div>
          ) : slots.length === 0 ? (
            <div className="ledger-empty">暂无 ledger 数据</div>
          ) : slots.map((slot) => (
            <div key={slot.id || slot.slot} className="ledger-slot-item">
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

    </>
  );
};

export const LedgerMonitor: React.FC<LedgerMonitorProps> = ({ sessionId, label }) => {
  const [latestSlots, setLatestSlots] = useState<LedgerSlot[]>([]);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [resolvedSessionId, setResolvedSessionId] = useState(sessionId || '');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    setResolvedSessionId(sessionId);
    setLoadError(null);
    const controller = new AbortController();
    const load = async () => {
      try {
        const result = await fetchLedgerPage(sessionId, 5, 0, controller.signal);
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
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [sessionId]);

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
