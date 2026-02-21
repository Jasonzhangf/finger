import React from 'react';
import type { Loop } from './types';
import { LoopRow } from './LoopRow';
import './RunningZone.css';

interface RunningZoneProps {
  title: string;
  loop?: Loop;
  selectedLoopId?: string;
  onSelectLoop?: (loopId: string) => void;
}

export const RunningZone: React.FC<RunningZoneProps> = ({ 
  title, 
  loop, 
  selectedLoopId, 
  onSelectLoop 
}) => {
  if (!loop) {
    return (
      <div className="zone running-zone">
        <div className="zone-header">{title}</div>
        <div className="zone-body">
          <div className="empty-message">暂无执行中循环</div>
        </div>
      </div>
    );
  }

  return (
    <div className="zone running-zone">
      <div className="zone-header">{title}</div>
      <div className="zone-body running-scroll">
        <LoopRow
          loop={loop}
          selected={loop.id === selectedLoopId}
          onSelect={() => onSelectLoop?.(loop.id)}
        />
      </div>
    </div>
  );
};
