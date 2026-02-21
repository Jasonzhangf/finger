import React from 'react';
import type { RuntimeEvent } from '../../api/types';
import './MessageItem.css';

interface MessageItemProps {
  event: RuntimeEvent;
}

export const MessageItem: React.FC<MessageItemProps> = ({ event }) => {
  const isUser = event.role === 'user';
  const isAgent = event.role === 'agent';

  return (
    <div className={`message-item ${isUser ? 'user' : isAgent ? 'agent' : 'system'}`}>
      <div className="message-avatar">
        {isUser ? '👤' : isAgent ? '🤖' : 'ℹ️'}
      </div>
      <div className="message-content-wrapper">
        <div className="message-header">
          <span className="sender-label">
            {isUser ? 'You' : isAgent ? (event.agentName || event.agentId || 'Agent') : 'System'}
          </span>
          <span className="message-time">
            {new Date(event.timestamp).toLocaleTimeString()}
          </span>
        </div>
        <div className="message-body">
          {event.content}
          {event.images && event.images.length > 0 && (
            <div className="message-images">
              {event.images.map(image => (
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
};
