import React, { useState, useRef, useEffect } from 'react';
import './RightPanel.css';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
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

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages([
      ...messages,
      {
        id: Date.now().toString(),
        role: 'user',
        content: input,
        timestamp: new Date(),
      },
    ]);
    setInput('');
  };

  return (
    <div className="right-panel-container">
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
    </div>
  );
};
