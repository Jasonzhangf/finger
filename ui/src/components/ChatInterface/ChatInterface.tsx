import { useState, useRef, useEffect } from 'react';
import type { WsMessage, AgentRuntime, WorkflowExecutionState } from '../../api/types.js';
import './ChatInterface.css';

interface ChatMessage {
  id: string;
  role: 'user' | 'orchestrator' | 'agent' | 'system';
  content: string;
  timestamp: string;
  agentStatus?: AgentRuntime['status'];
  agentId?: string;
  metadata?: {
    workflowId?: string;
    taskId?: string;
    action?: string;
    thought?: string;
  };
}

interface ChatInterfaceProps {
  
  workflowState: WorkflowExecutionState | null;
  agents: AgentRuntime[];
  onUserInput: (input: string) => Promise<void>;
  onPause: () => void;
  onResume: () => void;
  wsUrl?: string;
}

export const ChatInterface: React.FC<ChatInterfaceProps> = ({
  
  workflowState,
  agents,
  onUserInput,
  onPause,
  onResume,
  wsUrl = 'ws://localhost:8081',
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isPaused, setIsPaused] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // WebSocket connection for real-time updates
  useEffect(() => {
    if (!wsUrl) return;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[ChatInterface] WebSocket connected');
      addSystemMessage('Connected to execution stream');
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) {
        console.error('[ChatInterface] Failed to parse WS message:', e);
      }
    };

    ws.onerror = (error) => {
      console.error('[ChatInterface] WebSocket error:', error);
      addSystemMessage('Connection error - retrying...');
    };

    ws.onclose = () => {
      console.log('[ChatInterface] WebSocket disconnected');
    };

    return () => {
      ws.close();
    };
  }, [wsUrl]);

  const handleWsMessage = (msg: WsMessage) => {
    const { type, payload } = msg;

    switch (type) {
      case 'workflow_update':
        handleWorkflowUpdate(payload as any);
        break;
      case 'agent_update':
        handleAgentUpdate(payload as any);
        break;
      case 'execution_step':
        handleExecutionStep(payload as any);
        break;
      case 'message':
        addAgentMessage((payload as any).agentId, (payload as any).content);
        break;
      default:
        break;
    }
  };

  const handleWorkflowUpdate = (payload: any) => {
    if (payload.orchestratorState) {
      const { round, thought, action } = payload.orchestratorState;
      addOrchestratorMessage(`Round ${round}: ${action || 'processing'}`, { thought });
    }
  };

  const handleAgentUpdate = (payload: any) => {
    const agent = agents.find(a => a.id === payload.agentId);
    if (agent && payload.step) {
      addAgentMessage(
        payload.agentId,
        `Action: ${payload.step.action}\nObservation: ${payload.step.observation || 'pending'}`,
        { action: payload.step.action, thought: payload.step.thought }
      );
    }
  };

  const handleExecutionStep = (payload: any) => {
    if (payload.thought) {
      addOrchestratorMessage(payload.thought, { action: payload.action });
    }
  };

  const addSystemMessage = (content: string) => {
    setMessages(prev => [...prev, {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'system',
      content,
      timestamp: new Date().toISOString(),
    }]);
  };

  const addOrchestratorMessage = (content: string, metadata?: ChatMessage['metadata']) => {
    setMessages(prev => [...prev, {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'orchestrator',
      content,
      timestamp: new Date().toISOString(),
      metadata,
    }]);
  };

  const addAgentMessage = (agentId: string, content: string, metadata?: ChatMessage['metadata']) => {
    const agent = agents.find(a => a.id === agentId);
    setMessages(prev => [...prev, {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'agent',
      content,
      timestamp: new Date().toISOString(),
      agentId,
      agentStatus: agent?.status,
      metadata,
    }]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setIsLoading(true);

    setMessages(prev => [...prev, {
      id: `msg-${Date.now()}-user`,
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString(),
    }]);

    try {
      await onUserInput(userMessage);
    } catch (error) {
      addSystemMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePause = () => {
    setIsPaused(true);
    onPause();
    addSystemMessage('Execution paused');
  };

  const handleResume = () => {
    setIsPaused(false);
    onResume();
    addSystemMessage('Execution resumed');
  };

  const formatTimestamp = (ts: string) => {
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  const getMessageClass = (msg: ChatMessage) => {
    const baseClass = 'chat-message';
    switch (msg.role) {
      case 'user':
        return `${baseClass} user-message`;
      case 'orchestrator':
        return `${baseClass} orchestrator-message`;
      case 'agent':
        return `${baseClass} agent-message ${msg.agentStatus || ''}`;
      default:
        return `${baseClass} system-message`;
    }
  };

  return (
    <div className="chat-interface">
      <div className="chat-header">
        <h3>Session Chat</h3>
        {workflowState && (
          <div className="workflow-status">
            <span className={`status-badge ${workflowState.status}`}>
              {workflowState.status}
            </span>
            {isPaused ? (
              <button onClick={handleResume} className="control-btn resume">
                Resume
              </button>
            ) : (
              <button 
                onClick={handlePause} 
                className="control-btn pause"
                disabled={workflowState.status === 'completed' || workflowState.status === 'failed'}
              >
                Pause
              </button>
            )}
          </div>
        )}
      </div>

      <div className="messages-container">
        {messages.map((msg) => (
          <div key={msg.id} className={getMessageClass(msg)}>
            <div className="message-header">
              <span className="message-role">
                {msg.role === 'agent' ? agents.find(a => a.id === msg.agentId)?.name || msg.agentId : msg.role}
              </span>
              <span className="message-time">{formatTimestamp(msg.timestamp)}</span>
            </div>
            <div className="message-content">
              {msg.content.split('\n').map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
            {msg.metadata?.thought && (
              <details className="message-details">
                <summary>Thought Process</summary>
                <pre>{msg.metadata.thought}</pre>
              </details>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="input-form">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isPaused ? "Enter new instruction..." : "Type a message..."}
          disabled={isLoading && !isPaused}
          className="chat-input"
        />
        <button type="submit" disabled={isLoading || !input.trim()} className="send-btn">
          {isLoading ? 'Sending...' : 'Send'}
        </button>
      </form>
    </div>
  );
};
