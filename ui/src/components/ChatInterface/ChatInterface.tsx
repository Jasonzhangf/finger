import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import './ChatInterface.css';
import type { RuntimeEvent, RuntimeFile, RuntimeImage, UserInputPayload, WorkflowExecutionState } from '../../api/types.js';

export interface InputCapability {
  acceptText: boolean;
  acceptImages: boolean;
  acceptFiles: boolean;
  acceptedFileMimePrefixes?: string[];
}

interface AgentRunStatus {
  phase: 'idle' | 'running' | 'error';
  text: string;
  updatedAt: string;
}

interface ChatInterfaceProps {
  executionState: WorkflowExecutionState | null;
  agents: Array<{ id: string; name: string; status: string }>;
  events: RuntimeEvent[];
  contextEditableEventIds?: string[];
  agentRunStatus?: AgentRunStatus;
  onSendMessage: (payload: UserInputPayload) => void;
  onEditMessage?: (eventId: string, content: string) => Promise<boolean>;
  onDeleteMessage?: (eventId: string) => Promise<boolean>;
  onCreateNewSession?: () => Promise<void> | void;
  onPause: () => void;
  onResume: () => void;
  isPaused: boolean;
  isConnected: boolean;
  onAgentClick?: (agentId: string) => void;
  inputCapability?: InputCapability;
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

async function createPreviewImages(files: FileList | null): Promise<RuntimeImage[]> {
  if (!files) return [];

  const all = await Promise.all(
    Array.from(files).map(async (file) => {
      const dataUrl = await toDataUrl(file);
      return {
        id: createRuntimeId(file),
        name: file.name,
        url: dataUrl,
        dataUrl,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
      };
    }),
  );
  return all;
}

async function createPreviewFiles(files: FileList | null): Promise<RuntimeFile[]> {
  if (!files) return [];

  const all = await Promise.all(
    Array.from(files).map(async (file) => {
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
          {event.toolName && (
            <div className={`tool-event-chip ${event.kind || 'status'}`}>
              <span className="tool-event-label">{event.kind === 'action' ? '执行中' : '工具结果'}</span>
              <span className="tool-event-name">{event.toolName}</span>
              {typeof event.toolDurationMs === 'number' && (
                <span className="tool-event-duration">{event.toolDurationMs}ms</span>
              )}
            </div>
          )}
          {event.content}
          {event.kind === 'action' && event.toolName && (() => {
            const toolInput = formatToolInput(event.toolInput);
            if (!toolInput) return null;
            return (
              <pre className="tool-input-block">{toolInput}</pre>
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
  disabled?: boolean;
}> = ({ draft, onDraftChange, onSend, onCreateNewSession, inputHistory, inputCapability, isPaused, disabled }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [inputWarning, setInputWarning] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [historySnapshot, setHistorySnapshot] = useState<string>('');
  const images = draft.images ?? [];
  const files = draft.files ?? [];

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
    if (normalizedText === '/new' && !hasAttachments) {
      setHistoryCursor(null);
      setHistorySnapshot('');
      onDraftChange({ text: '', images: [], files: [] });
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
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

    onSend(sanitized.payload);
    setHistoryCursor(null);
    setHistorySnapshot('');

    onDraftChange({ text: '', images: [], files: [] });
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [draft, inputCapability, onCreateNewSession, onDraftChange, onSend]);

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

  const handleImageChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!inputCapability.acceptImages) {
      setInputWarning('当前 Agent 不支持图片输入');
      e.target.value = '';
      return;
    }
    void (async () => {
      const newImages = await createPreviewImages(fileList);
      if (newImages.length === 0) return;
      onDraftChange((prev) => ({
        ...prev,
        images: [...(prev.images ?? []), ...newImages],
      }));
      setInputWarning(null);
    })();
    e.target.value = '';
  }, [inputCapability.acceptImages, onDraftChange]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    void (async () => {
      const newFiles = await createPreviewFiles(fileList);
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

      if (normalizedFiles.length === 0 && normalizedImages.length === 0 && droppedCount > 0) {
        setInputWarning('当前 Agent 不支持该附件类型');
        return;
      }

      onDraftChange((prev) => ({
        ...prev,
        ...(normalizedFiles.length > 0 ? { files: [...(prev.files ?? []), ...normalizedFiles] } : {}),
        ...(normalizedImages.length > 0 ? { images: [...(prev.images ?? []), ...normalizedImages] } : {}),
      }));
      if (droppedCount > 0) {
        setInputWarning(`已过滤 ${droppedCount} 个不受支持的附件`);
      } else {
        setInputWarning(null);
      }
    })();
    e.target.value = '';
  }, [inputCapability, onDraftChange]);

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
        <div className="textarea-wrapper">
          <textarea
            data-testid="chat-input"
            ref={textareaRef}
            value={draft.text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            placeholder={isPaused ? '系统已暂停，输入指令后点击继续' : '输入任务指令... (Shift+Enter 换行，/new 新会话)'}
            rows={4}
            disabled={disabled}
          />
        </div>

        <div className="composer-toolbar">
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
  onSendMessage,
  onEditMessage,
  onDeleteMessage,
  onCreateNewSession,
  onPause,
  onResume,
  isPaused,
  isConnected,
  onAgentClick,
  inputCapability,
}) => {
  const chatRef = useRef<HTMLDivElement>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [draft, setDraft] = useState<UserInputPayload>({ text: '', images: [], files: [] });
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [visibleEventCount, setVisibleEventCount] = useState<number>(MESSAGE_PAGE_SIZE);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<RuntimeImage | null>(null);
  const effectiveInputCapability = inputCapability ?? DEFAULT_INPUT_CAPABILITY;

  useEffect(() => {
    if (!chatRef.current) return;
    chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [events]);

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

  const handleSend = useCallback((payload: UserInputPayload) => {
    onSendMessage(payload);
    const text = payload.text.trim();
    if (text.length === 0) return;
    setInputHistory((prev) => {
      if (prev.length > 0 && prev[prev.length - 1] === text) return prev;
      const next = [...prev, text];
      return next.length > 100 ? next.slice(next.length - 100) : next;
    });
  }, [onSendMessage]);

  const handleRetryMessage = useCallback((event: RuntimeEvent) => {
    onSendMessage({
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

  const displayedEvents = useMemo(
    () => eventsWithKeys.slice(-Math.max(1, visibleEventCount)),
    [eventsWithKeys, visibleEventCount],
  );

  const hiddenEventsCount = eventsWithKeys.length - displayedEvents.length;

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
    onSendMessage(payload);
    setContextMenu(null);
  }, [activeMenuEvent, onSendMessage]);

  const handleLoadMoreEvents = useCallback(() => {
    setVisibleEventCount((prev) => prev + MESSAGE_PAGE_SIZE);
  }, []);

  return (
    <div className="chat-interface">
      <div className="chat-header">
        <div className="header-title">
          <span className="title-text">对话面板</span>
          {!isConnected && <span className="connection-badge offline">离线</span>}
        </div>

        {executionState && (
          <div className="header-controls">
            <button
              className={`control-btn ${isPaused ? 'paused' : ''}`}
              onClick={isPaused ? onResume : onPause}
            >
              {isPaused ? '▶ 继续' : '⏸ 暂停'}
            </button>
          </div>
        )}
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
          <span className={`agent-run-dot ${agentRunStatus.phase === 'running' ? 'pulsing' : ''}`} />
          <span className="agent-run-text">{agentRunStatus.text}</span>
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
        disabled={!isConnected}
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
