import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import './ChatInterface.css';
import type { RuntimeEvent, RuntimeImage, UserInputPayload, WorkflowExecutionState } from '../../api/types.js';

interface ChatInterfaceProps {
  executionState: WorkflowExecutionState | null;
  agents: Array<{ id: string; name: string; status: string }>;
  events: RuntimeEvent[];
  onSendMessage: (payload: UserInputPayload) => void;
  onPause: () => void;
  onResume: () => void;
  isPaused: boolean;
  isConnected: boolean;
  onAgentClick?: (agentId: string) => void;
}

function createPreviewImages(files: FileList | null): RuntimeImage[] {
  if (!files) return [];
  return Array.from(files).map((file) => ({
    id: `${Date.now()}-${file.name}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    url: URL.createObjectURL(file),
  }));
}

const MessageItem = React.memo<{
  event: RuntimeEvent;
  agentStatus?: string;
  onAgentClick?: (agentId: string) => void;
}>(({ event, agentStatus, onAgentClick }) => {
  const isUser = event.role === 'user';
  const isAgent = event.role === 'agent';
  const isSystem = event.role === 'system';
  
  // Handle pending/confirmed/error states for user messages
  const isPending = event.agentId === 'pending';
  const isConfirmed = event.agentId === 'confirmed';
  const isError = event.agentId === 'error';
  
  const getMessageStatus = () => {
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
  
  return (
    <div className={`message ${isUser ? 'user' : isAgent ? 'agent' : 'system'} ${messageStatus || ''}`}>
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
          <span className="message-time">{new Date(event.timestamp).toLocaleTimeString()}</span>
        </div>
        
        <div className="message-body">
          {event.content}
          {event.images && event.images.length > 0 && (
            <div className="message-images">
              {event.images.map((image) => (
                <div key={image.id} className="message-image-item">
                  <img src={image.url} alt={image.name} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

MessageItem.displayName = 'MessageItem';

const ChatInput: React.FC<{
  onSend: (text: string, images: RuntimeImage[]) => void;
  isPaused: boolean;
  disabled?: boolean;
}> = ({ onSend, isPaused, disabled }) => {
  const [text, setText] = useState('');
  const [images, setImages] = useState<RuntimeImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    onSend(trimmed, images);
    setText('');
    setImages([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, images, onSend]);
  
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle Enter without Shift, but not during IME composition
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);
  
  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, []);
  
  const handleImageChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newImages = createPreviewImages(e.target.files);
    setImages(prev => [...prev, ...newImages]);
  }, []);
  
  const removeImage = useCallback((id: string) => {
    setImages(prev => {
      const target = prev.find(img => img.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter(img => img.id !== id);
    });
  }, []);
  
  useEffect(() => {
    return () => {
      images.forEach(img => URL.revokeObjectURL(img.url));
    };
  }, [images]);
  
  const canSend = text.trim().length > 0 || images.length > 0;
  
  return (
    <div className="chat-input-container">
      {images.length > 0 && (
        <div className="image-preview-bar">
          {images.map(img => (
            <div key={img.id} className="image-preview-chip">
              <img src={img.url} alt={img.name} />
              <button className="remove-btn" onClick={() => removeImage(img.id)}>×</button>
            </div>
          ))}
        </div>
      )}
      
      <div className="input-row">
        <label className="attach-btn" title="添加图片">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={handleImageChange}
            disabled={disabled}
          />
        </label>
        
        <div className="textarea-wrapper">
          <textarea data-testid="chat-input"
            ref={textareaRef}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            placeholder={isPaused ? '系统已暂停，输入指令后点击继续' : '输入任务指令... (Shift+Enter 换行)'}
            rows={1}
            disabled={disabled}
          />
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
  );
};

export const ChatInterface: React.FC<ChatInterfaceProps> = ({
  executionState,
  agents,
  events,
  onSendMessage,
  onPause,
  onResume,
  isPaused,
  isConnected,
  onAgentClick,
}) => {
  const chatRef = useRef<HTMLDivElement>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  useEffect(() => {
    if (!chatRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
    if (isNearBottom) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    } else {
      setShowScrollToBottom(true);
    }
  }, [events]);

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

  const handleSend = useCallback((text: string, images: RuntimeImage[]) => {
    onSendMessage({ text, images });
  }, [onSendMessage]);

  const agentStatusMap = useMemo(() => {
    const map = new Map<string, string>();
    agents.forEach(agent => map.set(agent.id, agent.status));
    return map;
  }, [agents]);

  const progress = useMemo(() => {
    if (!executionState) return null;
    const current = executionState.orchestrator.currentRound;
    const max = executionState.orchestrator.maxRounds;
    return { current, max, percent: Math.round((current / Math.max(1, max)) * 100) };
  }, [executionState]);

  // Generate stable keys for events
  const eventsWithKeys = useMemo(() => {
    return events.map((event, index) => ({
      ...event,
      key: event.id || `${event.timestamp}-${event.role}-${index}`,
    }));
  }, [events]);

  return (
    <div className="chat-interface">
      <div className="chat-header">
        <div className="header-title">
          <span className="title-text">对话面板</span>
          {!isConnected && <span className="connection-badge offline">离线</span>}
        </div>
        
        {executionState && (
          <div className="header-controls">
            {progress && (
              <div className="round-progress">
                <span className="round-label">Round {progress.current}/{progress.max}</span>
                <div className="progress-bar-bg">
                  <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
                </div>
              </div>
            )}
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
        {events.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <div className="empty-text">开始对话，输入任务指令...</div>
          </div>
        ) : (
          eventsWithKeys.map((event) => (
            <MessageItem
              key={event.key}
              event={event}
              agentStatus={event.agentId ? (agentStatusMap.get(event.agentId) ?? 'unknown') : undefined}
              onAgentClick={onAgentClick}
            />
          ))
        )}
      </div>

      {showScrollToBottom && (
        <button className="scroll-to-bottom-btn" onClick={scrollToBottom}>
          ↓ 滚动到底部
        </button>
      )}

      <ChatInput
        onSend={handleSend}
        isPaused={isPaused}
        disabled={!isConnected}
      />
    </div>
  );
};
