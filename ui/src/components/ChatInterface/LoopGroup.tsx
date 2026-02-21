import React, { useState } from 'react';
import type { RuntimeEvent } from '../../api/types';
import type { Loop } from '../TaskFlowCanvas/types';
import { MessageItem } from './MessageItem';
import './LoopGroup.css';

interface LoopGroupProps {
  loop: Loop & { loopGroup?: 'plan' | 'design' | 'execution' | 'running' };
  events: RuntimeEvent[];
  isRunning?: boolean;
}

export const LoopGroup: React.FC<LoopGroupProps> = ({ loop, events, isRunning }) => {
  const [expanded, setExpanded] = useState(isRunning || false);

  const resultClass = loop.result === 'success' ? 'success' : loop.result === 'failed' ? 'failed' : '';
  const phaseEmoji = loop.phase === 'plan' ? '📋' : loop.phase === 'design' ? '🏗️' : loop.phase === 'execution' ? '⚡' : '🔄';

  return (
    <div className={`loop-group ${isRunning ? 'running' : ''} ${resultClass}`}>
      <div 
        className="loop-group-header" 
        onClick={() => setExpanded(!expanded)}
      >
        <span className="loop-toggle">{expanded ? '▼' : '▶'}</span>
        <span className="loop-phase-emoji">{phaseEmoji}</span>
        <span className="loop-id">{loop.id}</span>
        <span className="loop-phase">{loop.phase}</span>
        {loop.result && (
          <span className={`loop-result ${resultClass}`}>
            {loop.result === 'success' ? '✓ 完成' : '✗ 失败'}
          </span>
        )}
        {isRunning && <span className="running-badge">进行中</span>}
        <span className="event-count">{events.length} 条消息</span>
      </div>
      
      {expanded && (
        <div className="loop-group-body">
          {/* Loop nodes summary */}
          <div className="loop-nodes-summary">
            {loop.nodes.map(node => (
              <div key={node.id} className={`node-summary ${node.status}`}>
                <span className="node-type">{node.type}</span>
                <span className="node-title">{node.title}</span>
                <span className="node-status-mark">
                  {node.status === 'done' ? '✓' : node.status === 'failed' ? '✗' : '⟳'}
                </span>
              </div>
            ))}
          </div>
          
          {/* Events in this loop */}
          <div className="loop-events">
            {events.map(event => (
              <MessageItem key={event.id} event={event} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
