import React from 'react';
import type { Loop } from './types';
import { LoopNode } from './LoopNode';
import './LoopRow.css';

interface LoopRowProps {
  loop: Loop;
  selected: boolean;
  onSelect: () => void;
}

export const LoopRow: React.FC<LoopRowProps> = ({ loop, selected, onSelect }) => {
  return (
    <div className={`loop-row ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="loop-row-header">
        <span className="loop-id">{loop.id}</span>
        <span className="loop-phase-badge">{loop.phase}</span>
        <span className="loop-node-count">节点：{loop.nodes.length}</span>
      </div>
      <div className="loop-content">
        {loop.nodes.map((node, index) => (
          <React.Fragment key={node.id}>
            {index > 0 && (
              <div className={`arrow ${loop.nodes[index - 1].status === 'failed' ? 'failed' : 'success'}`}>
                →
              </div>
            )}
            <LoopNode node={node} />
          </React.Fragment>
        ))}
        {loop.nodes[loop.nodes.length - 1]?.status === 'running' && (
          <div className="arrow running">⟳</div>
        )}
      </div>
    </div>
  );
};
