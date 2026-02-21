import React from 'react';
import type { LoopNode as LoopNodeType } from './types';
import { getNodeColor, getNodeStatusClass } from './types';
import './LoopNode.css';

interface LoopNodeProps {
  node: LoopNodeType;
}

export const LoopNode: React.FC<LoopNodeProps> = ({ node }) => {
  const statusClass = getNodeStatusClass(node.status);
  const borderColor = getNodeColor(node.type);
  
  return (
    <div 
      className={`loop-node ${statusClass}`}
      style={{ borderColor }}
    >
      <span className="node-status">
        {node.status === 'done' ? '✓' : node.status === 'failed' ? '✗' : node.status === 'running' ? '⟳' : '⏸'}
      </span>
      <h5 className="node-title">{node.title}</h5>
      <p className="node-text">{node.text}</p>
    </div>
  );
};
