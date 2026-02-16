import React, { useState, useRef, useEffect } from 'react';
import './RightPanel.css';
import type { WorkflowExecutionState } from '../../api/types.js';

interface RightPanelProps {
  executionState: WorkflowExecutionState | null;
  agents: Array<{ id: string; name: string; status: string; currentTaskId?: string }>;
  onSendMessage: (message: string) => void;
  onPause: () => void;
  onResume: () => void;
  isPaused: boolean;
  isConnected: boolean;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'agent';
  content: string;
  agentId?: string;
  agentName?: string;
  timestamp: Date;
  type?: 'thought' | 'action' | 'observation' | 'complete' | 'error';
}

export const RightPanel: React.FC<RightPanelProps> = ({
  executionState,
  onSendMessage,
  onPause,
  onResume,
  isPaused,
  isConnected,
}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);

  // Sync execution state to messages
  useEffect(() => {
    if (!executionState) return;

    const newMessages: Message[] = [];

    // Add orchestrator thought
    if (executionState.orchestrator.thought) {
      newMessages.push({
        id: `orch-${Date.now()}`,
        role: 'agent',
        content: executionState.orchestrator.thought,
        agentId: executionState.orchestrator.id,
        agentName: 'Orchestrator',
        timestamp: new Date(),
        type: 'thought',
      });
    }

    // Add agent execution updates
    executionState.agents.forEach((agent) => {
      if (agent.currentTaskId) {
        newMessages.push({
          id: `${agent.id}-${Date.now()}`,
          role: 'agent',
          content: `${agent.name} 正在执行任务: ${agent.currentTaskId}`,
          agentId: agent.id,
          agentName: agent.name,
          timestamp: new Date(),
          type: 'action',
        });
      }
    });

    // Add execution path updates
    executionState.executionPath.forEach((path, idx) => {
      if (path.status === 'active' && path.message) {
        newMessages.push({
          id: `path-${idx}-${Date.now()}`,
          role: 'system',
          content: path.message,
          timestamp: new Date(),
          type: 'observation',
        });
      }
    });

    if (newMessages.length > 0) {
      setMessages((prev) => [...prev, ...newMessages]);
    }
  }, [executionState]);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    
    const newMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: new Date(),
    };
    
    setMessages((prev) => [...prev, newMessage]);
    onSendMessage(input);
    setInput('');
  };

  const getMessageStyle = (msg: Message) => {
    if (msg.role === 'user') return 'message user';
    if (msg.role === 'system') {
      return 'message system';
    }
    if (msg.role === 'agent') {
      return `message agent ${msg.type || ''}`;
    }
    return 'message assistant';
  };

  return (
    <div className="right-panel-container">
      <div className="panel-header">
        <div className="panel-title">
          💬 对话与执行状态
          {!isConnected && (
            <span className="connection-status offline">离线</span>
          )}
        </div>
        
        {executionState && (
          <button 
            className={`pause-btn ${isPaused ? 'paused' : ''}`}
            onClick={isPaused ? onResume : onPause}
          >
            {isPaused ? '▶ 继续' : '⏸ 暂停'}
          </button>
        )}
      </div>

      {executionState && (
        <div className="agent-status-bar">
          {executionState.agents.map((agent) => (
            <div 
              key={agent.id} 
              className={`mini-agent ${agent.status}`}
              title={`${agent.name}: ${agent.status}`}
            >
              <span className="dot" />
              <span className="name">{agent.name.split('-')[0]}</span>
            </div>
          ))}
        </div>
      )}

      <div className="chat-section">
        <div className="chat-messages" ref={chatRef}>
          {messages.length === 0 ? (
            <div className="empty-chat">
              <p>输入任务开始编排...</p>
              <div className="quick-actions">
                <button onClick={() => { setInput('创建一个 Node.js 项目'); }}>
                  创建项目
                </button>
                <button onClick={() => { setInput('分析代码架构'); }}>
                  分析架构
                </button>
                <button onClick={() => { setInput('编写单元测试'); }}>
                  编写测试
                </button>
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className={getMessageStyle(msg)}>
                {msg.agentName && (
                  <div className="agent-label">{msg.agentName}</div>
                )}
                <div className="message-content">{msg.content}</div>
                {msg.type && (
                  <div className="message-type">{msg.type}</div>
                )}
              </div>
            ))
          )}
        </div>
        
        <div className="input-area">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            placeholder={isPaused ? "已暂停，点击继续恢复执行..." : "输入任务或指令..."}
            disabled={isPaused}
          />
          <button onClick={handleSend} disabled={isPaused || !input.trim()}>
            发送
          </button>
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
                width: `${(executionState.orchestrator.currentRound / executionState.orchestrator.maxRounds) * 100}%` 
              }}
            />
          </div>
          <div className="task-stats">
            <span>任务: {executionState.tasks.filter(t => t.status === 'completed').length}/{executionState.tasks.length}</span>
            <span className={`status ${executionState.status}`}>{executionState.status}</span>
          </div>
        </div>
      )}
    </div>
  );
};
