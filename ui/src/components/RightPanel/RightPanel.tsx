import React, { useState, useRef, useEffect } from 'react';
import './RightPanel.css';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface BDTask {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'blocked' | 'closed';
  priority: number;
}

export const RightPanel: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    { id: '1', role: 'user', content: 'Design login module architecture', timestamp: new Date() },
    { id: '2', role: 'assistant', content: 'Architecture design complete, including API interfaces and database models.', timestamp: new Date() },
    { id: '3', role: 'user', content: 'Need to add unit tests', timestamp: new Date() },
    { id: '4', role: 'assistant', content: 'Added login test cases, coverage 92%.', timestamp: new Date() },
  ]);
  const [input, setInput] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);

  const [bdTasks] = useState<BDTask[]>([
    { id: 'finger-3', title: 'Design login architecture', status: 'in_progress', priority: 0 },
    { id: 'finger-4', title: 'Implement login API', status: 'in_progress', priority: 0 },
    { id: 'finger-5', title: 'Write tests', status: 'open', priority: 1 },
    { id: 'finger-6', title: 'Security audit', status: 'blocked', priority: 0 },
    { id: 'finger-7', title: 'Requirements analysis', status: 'closed', priority: 0 },
  ]);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages([...messages, {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: new Date(),
    }]);
    setInput('');
  };

  const getStatusIcon = (status: BDTask['status']) => {
    switch (status) {
      case 'open': return '⚪';
      case 'in_progress': return '🔵';
      case 'blocked': return '🔴';
      case 'closed': return '🟢';
    }
  };

  return (
    <div className="right-panel-container">
      {/* Chat Area */}
      <div className="chat-section">
        <div className="chat-header">Chat History</div>
        <div className="chat-messages" ref={chatRef}>
          {messages.map((msg) => (
            <div key={msg.id} className={`message ${msg.role}`}>
              {msg.content}
            </div>
          ))}
        </div>
        <div className="input-area">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Type a message..."
          />
          <button onClick={handleSend}>Send</button>
        </div>
      </div>

      {/* BD Status Panel */}
      <div className="bd-status-section">
        <div className="bd-header">BD Task Status</div>
        <div className="bd-tasks">
          {bdTasks.map((task) => (
            <div key={task.id} className={`bd-task-item ${task.status}`}>
              <span className="status-icon">{getStatusIcon(task.status)}</span>
              <span className="task-id">{task.id}</span>
              <span className="task-title">{task.title}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
