import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import './RightPanel.css';
import type { RuntimeEvent, RuntimeImage, UserInputPayload, WorkflowExecutionState } from '../../api/types.js';

interface RightPanelProps {
  executionState: WorkflowExecutionState | null;
  agents: Array<{ id: string; name: string; status: string; currentTaskId?: string }>;
  events: RuntimeEvent[];
  highlightedAgentId?: string | null;
  onSelectAgent: (agentId: string) => void;
  onInspectAgent: (agentId: string) => void;
  onSendMessage: (payload: UserInputPayload) => void;
  onPause: () => void;
  onResume: () => void;
  isPaused: boolean;
  isConnected: boolean;
  resumePrompt?: {
    visible: boolean;
    summary: string;
    progress: number;
    pendingCount: number;
    requireConfirm: boolean;
    isResuming: boolean;
    onResumeNow: () => void;
    onDismiss: () => void;
    onToggleRequireConfirm: (value: boolean) => void;
  };
}

function createPreviewImages(files: FileList | null): RuntimeImage[] {
  if (!files) return [];
  return Array.from(files).map((file) => ({
    id: `${Date.now()}-${file.name}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    url: URL.createObjectURL(file),
  }));
}

// Message item component for better performance
const MessageItem = React.memo<{
  event: RuntimeEvent & { className: string };
  isSelected: boolean;
  agentStatus?: string;
  onAgentClick: (agentId: string) => void;
}>(({ event, isSelected, agentStatus, onAgentClick }) => {
  const isUser = event.role === 'user';
  const isAgent = event.role === 'agent';
  const isSystemWithAgent = event.role === 'system' && event.agentId;
  
  return (
    <div className={`message ${isUser ? 'user' : isAgent ? 'agent' : 'system'} ${isSelected ? 'selected' : ''}`}>
      <div className="message-avatar">
        {isUser ? '👤' : isAgent ? '🤖' : isSystemWithAgent ? '🤖' : 'ℹ️'}
      </div>
      <div className="message-content-wrapper">
        <div className="message-header">
          {isAgent && event.agentId && (
            <>
              <button
                type="button"
                className="agent-name-btn"
                onClick={() => event.agentId && onAgentClick(event.agentId)}
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
          {isSystemWithAgent && event.agentId && (
            <span className="sender-label">{event.agentName || event.agentId}</span>
          )}
          {event.role === 'system' && !isSystemWithAgent && <span className="sender-label">System</span>}
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

// Input area component
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);
  
  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // Auto-resize
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
          <textarea
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

export const RightPanel: React.FC<RightPanelProps> = ({
  executionState,
  agents,
  events,
  highlightedAgentId,
  onSelectAgent,
  onInspectAgent,
  onSendMessage,
  onPause,
  onResume,
  isPaused,
  isConnected,
  resumePrompt,
}) => {
  const chatRef = useRef<HTMLDivElement>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // Auto-scroll to bottom
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

  const handleAgentClick = useCallback((agentId: string) => {
    onSelectAgent(agentId);
    onInspectAgent(agentId);
  }, [onSelectAgent, onInspectAgent]);

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

  return (
    <div className="right-panel">
      {/* Header */}
      <div className="panel-header">
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

      {/* Resume Banner */}
      {resumePrompt?.visible && (
        <div className="resume-banner">
          <div className="banner-header">
            <span className="banner-icon">⚡</span>
            <span className="banner-title">检测到可恢复会话</span>
          </div>
          <div className="banner-progress">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${resumePrompt.progress}%` }} />
            </div>
            <span className="progress-text">{resumePrompt.progress}% · {resumePrompt.pendingCount} 待处理</span>
          </div>
          {resumePrompt.summary && (
            <div className="banner-summary">{resumePrompt.summary}</div>
          )}
          <div className="banner-actions">
            <button
              className="btn-primary"
              onClick={resumePrompt.onResumeNow}
              disabled={resumePrompt.isResuming}
            >
              {resumePrompt.isResuming ? '恢复中...' : '继续恢复'}
            </button>
            <button className="btn-secondary" onClick={resumePrompt.onDismiss}>
              稍后处理
            </button>
          </div>
        </div>
      )}

      {/* Progress Bar (when active) */}
      {progress && (
        <div className="progress-section">
          <div className="progress-info">
            <span>执行进度</span>
            <span>Round {progress.current}/{progress.max}</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="progress-status">
            <span>{executionState?.status}</span>
            <span>
              {executionState?.tasks.filter(t => t.status === 'completed').length || 0}/
              {executionState?.tasks.length || 0} 任务完成
            </span>
          </div>
        </div>
      )}

      {/* Chat Messages */}
      <div className="chat-container" ref={chatRef} onScroll={handleScroll}>
        {events.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <div className="empty-title">开始对话</div>
            <div className="empty-desc">在下方输入任务，Agent 将为您编排执行</div>
          </div>
        ) : (
          <div className="messages-list">
            {events.map((event) => (
              <MessageItem
                key={event.id}
                event={{ ...event, className: '' }}
                isSelected={highlightedAgentId === event.agentId}
                agentStatus={event.agentId ? (agentStatusMap.get(event.agentId) ?? 'unknown') : undefined}
                onAgentClick={handleAgentClick}
              />
            ))}
          </div>
        )}
        
        {showScrollToBottom && (
          <button className="scroll-to-bottom" onClick={scrollToBottom}>
            ↓ 新消息
          </button>
        )}
      </div>

      {/* Input Area */}
      <ChatInput
        onSend={handleSend}
        isPaused={isPaused}
        disabled={!isConnected}
      />
    </div>
  );
};
