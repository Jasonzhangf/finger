import React, { useEffect, useMemo, useRef, useState } from 'react';
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
}

function createPreviewImages(files: FileList | null): RuntimeImage[] {
  if (!files) return [];
  return Array.from(files).map((file) => ({
    id: `${Date.now()}-${file.name}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    url: URL.createObjectURL(file),
  }));
}

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
}) => {
  const [input, setInput] = useState('');
  const [images, setImages] = useState<RuntimeImage[]>([]);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chatRef.current) return;
    chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [events]);

  useEffect(() => {
    return () => {
      images.forEach((image) => URL.revokeObjectURL(image.url));
    };
  }, [images]);

  const grouped = useMemo(() => {
    return events.map((event) => {
      const roleClass = event.role === 'user' ? 'user' : event.role === 'agent' ? 'agent' : 'system';
      const selected = highlightedAgentId && event.agentId === highlightedAgentId;
      return {
        ...event,
        className: `message ${roleClass}${selected ? ' selected' : ''}`,
      };
    });
  }, [events, highlightedAgentId]);

  const agentStatusMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      map.set(agent.id, agent.status);
    }
    return map;
  }, [agents]);

  const handleInspectFromMessage = (agentId: string) => {
    onSelectAgent(agentId);
    onInspectAgent(agentId);
  };

  const handleSend = () => {
    const value = input.trim();
    if (!value && images.length === 0) return;

    onSendMessage({ text: value, images });
    setInput('');
    setImages((prev) => {
      prev.forEach((image) => URL.revokeObjectURL(image.url));
      return [];
    });
  };

  const handleImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const previews = createPreviewImages(event.target.files);
    setImages((prev) => {
      prev.forEach((image) => URL.revokeObjectURL(image.url));
      return previews;
    });
  };

  const removeImage = (imageId: string) => {
    setImages((prev) => {
      const target = prev.find((image) => image.id === imageId);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((image) => image.id !== imageId);
    });
  };

  return (
    <div className="right-panel-container">
      <div className="panel-header">
        <div className="panel-title">
          会话与执行
          {!isConnected && <span className="connection-status offline">离线</span>}
        </div>

        {executionState && (
          <button className={`pause-btn ${isPaused ? 'paused' : ''}`} onClick={isPaused ? onResume : onPause}>
            {isPaused ? '继续' : '暂停'}
          </button>
        )}
      </div>

      <div className="chat-section">
        <div className="chat-messages" ref={chatRef}>
          {grouped.length === 0 ? (
            <div className="empty-chat">
              <p>在右侧输入任务，开始编排执行。</p>
            </div>
          ) : (
            grouped.map((event) => (
              <div key={event.id} className={event.className}>
                {event.role === 'agent' && event.agentId ? (
                  <div className="agent-message-header">
                    <button
                      type="button"
                      className={`agent-avatar-btn${highlightedAgentId === event.agentId ? ' active' : ''}`}
                      onClick={() => handleInspectFromMessage(event.agentId as string)}
                      title="在画布中定位该 Agent"
                    >
                      {(event.agentName || event.agentId).slice(0, 1).toUpperCase()}
                    </button>
                    <button
                      type="button"
                      className="agent-label-btn"
                      onClick={() => handleInspectFromMessage(event.agentId as string)}
                    >
                      {event.agentName || event.agentId}
                    </button>
                    {agentStatusMap.get(event.agentId) && (
                      <span className={`agent-inline-status ${(agentStatusMap.get(event.agentId) || 'idle').toLowerCase()}`}>
                        {agentStatusMap.get(event.agentId)}
                      </span>
                    )}
                  </div>
                ) : (
                  event.agentName && <div className="agent-label">{event.agentName}</div>
                )}

                <div className="message-content">{event.content}</div>
                {event.images && event.images.length > 0 && (
                  <div className="message-images">
                    {event.images.map((image) => (
                      <div key={image.id} className="message-image-item">
                        <img src={image.url} alt={image.name} className="message-image-preview" />
                        <div className="message-image-name">{image.name}</div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="message-time">{new Date(event.timestamp).toLocaleString()}</div>
              </div>
            ))
          )}
        </div>

        <div className="input-area-wrapper">
          {images.length > 0 && (
            <div className="input-image-preview-list">
              {images.map((image) => (
                <div key={image.id} className="input-image-item">
                  <img src={image.url} alt={image.name} className="input-image-preview" />
                  <button className="remove-image-btn" onClick={() => removeImage(image.id)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="input-area">
            <label className="image-upload-btn" title="上传图片">
              📎
              <input type="file" accept="image/*" multiple onChange={handleImageChange} style={{ display: 'none' }} />
            </label>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSend();
              }}
              placeholder={isPaused ? '当前已暂停，可输入新指令后继续' : '输入任务或追加指令...'}
            />
            <button onClick={handleSend} disabled={!input.trim() && images.length === 0}>
              发送
            </button>
          </div>
        </div>
      </div>

      {executionState && (
        <div className="execution-progress">
          <div className="progress-header">
            <span>执行进度</span>
            <span className="round-info">
              Round {executionState.orchestrator.currentRound}/{executionState.orchestrator.maxRounds}
            </span>
          </div>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{
                width: `${(executionState.orchestrator.currentRound / Math.max(1, executionState.orchestrator.maxRounds)) * 100}%`,
              }}
            />
          </div>
          <div className="task-stats">
            <span>
              任务 {executionState.tasks.filter((t) => t.status === 'completed').length}/{executionState.tasks.length}
            </span>
            <span className={`status ${executionState.status}`}>{executionState.status}</span>
          </div>
        </div>
      )}
    </div>
  );
};
