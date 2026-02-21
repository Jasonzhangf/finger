import React from 'react';
import type { ZoneProps } from './types';
import { LoopCard } from './LoopCard';
import './QueueZone.css';

export const QueueZone: React.FC<ZoneProps> = ({ title, loops, selectedLoopId, onSelectLoop }) => {
  if (loops.length === 0) {
    return (
      <div className="zone queue-zone">
        <div className="zone-header">{title}</div>
        <div className="zone-body">
          <div className="empty-message">暂无排队循环</div>
        </div>
      </div>
    );
  }

  return (
    <div className="zone queue-zone">
      <div className="zone-header">{title}</div>
      <div className="zone-body queue-scroll">
        {loops.map(loop => (
          <LoopCard
            key={loop.id}
            loop={loop}
            selected={loop.id === selectedLoopId}
            onClick={() => onSelectLoop?.(loop.id)}
          />
        ))}
      </div>
    </div>
  );
};
