import React from 'react';
import type { RuntimeEvent } from '../../api/types';
import './MessageItem.css';

interface MessageItemProps {
  event: RuntimeEvent;
}

/**
 * 获取发送者显示名称
 * 遵循全局唯一真源原则，只消费来自 RuntimeEvent 的真源数据
 */
function getSenderDisplay(event: RuntimeEvent): string {
  // 用户消息
  if (event.role === 'user') {
    return 'You';
  }

  // 系统消息
  if (event.role === 'system') {
    return 'System';
  }

  // Agent 消息 - 主会话 vs 子会话
  if (event.sessionType === 'child') {
    // 子会话：显示 "编排者 → 执行者实例"
    const assigner = event.assignerName || event.assignerId || 'Orchestrator';
    const self = event.instanceName || event.agentName || event.agentId || 'Agent';
    return `${assigner} → ${self}`;
  } else {
    // 主会话：优先显示角色类型，否则显示 agent 名称
    if (event.roleType) {
      // 将角色类型转换为友好显示名
      switch (event.roleType) {
        case 'orchestrator':
          return 'Orchestrator';
        case 'executor':
          return 'Executor';
        case 'reviewer':
          return 'Reviewer';
        case 'planner':
          return 'Planner';
        case 'router':
          return 'Router';
        case 'understanding':
          return 'Understanding Agent';
        case 'searcher':
          return 'Researcher';
        case 'coder':
          return 'Coder';
        default:
          return event.roleType;
      }
    }
    // 回退到 agentName 或 agentId
    return event.agentName || event.agentId || 'Agent';
  }
}

export const MessageItem: React.FC<MessageItemProps> = ({ event }) => {
  const isUser = event.role === 'user';
  const isAgent = event.role === 'agent';
  const isReasoning = event.messageType === 'reasoning' || event.kind === 'thought';
  const senderDisplay = getSenderDisplay(event);

  return (
    <div className={`message-item ${isUser ? 'user' : isAgent ? 'agent' : 'system'}${isReasoning ? ' reasoning' : ''}`}>
      <div className="message-avatar">
        {isUser ? '👤' : isAgent ? '🤖' : 'ℹ️'}
      </div>
      <div className="message-content-wrapper">
        <div className="message-header">
          <span className="sender-label">
            {senderDisplay}
          </span>
          <span className="message-time">
            {new Date(event.timestamp).toLocaleTimeString()}
          </span>
        </div>
        <div className={`message-body${isReasoning ? ' reasoning-body' : ''}`}>
          {isReasoning ? (
            <div className="reasoning-content">
              <span className="reasoning-text">{event.content}</span>
            </div>
          ) : (
            event.content
          )}
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
