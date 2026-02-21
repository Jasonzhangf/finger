import React from 'react';
import type { Loop } from './types';
import { getNodeColor } from './types';
import './LoopCard.css';

interface LoopCardProps {
  loop: Loop;
  selected: boolean;
  onClick: () => void;
}

export const LoopCard: React.FC<LoopCardProps> = ({ loop, selected, onClick }) => {
  const resultClass = loop.result === 'success' ? 'success' : loop.result === 'failed' ? 'failed' : '';
  
  return (
    <div className={`loop-card ${resultClass} ${selected ? 'selected' : ''}`} onClick={onClick}>
      <div className="loop-card-header">
        <span className="loop-id">{loop.id}</span>
        <span className={`loop-result ${resultClass}`}>
          {loop.result === 'success' ? '✓' : loop.result === 'failed' ? '✗' : '⟳'}
        </span>
      </div>
      <div className="loop-card-body">
        <div className="loop-phase">{loop.phase}</div>
        <div className="loop-nodes">
          {loop.nodes.slice(0, 5).map(node => (
            <div 
              key={node.id} 
              className="mini-node"
              style={{ borderColor: getNodeColor(node.type) }}
            >
              <span className="mini-node-title">{node.title}</span>
              <span className={`mini-node-status ${node.status}`}>
                {node.status === 'done' ? '✓' : node.status === 'failed' ? '✗' : '⟳'}
              </span>
            </div>
          ))}
          {loop.nodes.length > 5 && (
            <span className="more-nodes">+{loop.nodes.length - 5}</span>
          )}
        </div>
      </div>
    </div>
  );
};
