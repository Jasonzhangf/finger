import React, { useMemo } from 'react';
import { HistoryZone } from './HistoryZone';
import { RunningZone } from './RunningZone';
import { QueueZone } from './QueueZone';
import type { TaskFlowCanvasProps } from './types';
import './TaskFlowCanvas.css';

export const TaskFlowCanvas: React.FC<TaskFlowCanvasProps> = ({
  epicId,
  planHistory,
  designHistory,
  executionHistory,
  runningLoop,
  queue,
  selectedLoopId,
  onSelectLoop,
}) => {
  const allHistory = useMemo(() => [
    ...planHistory,
    ...designHistory,
    ...executionHistory,
  ], [planHistory, designHistory, executionHistory]);

  return (
    <div className="task-flow-canvas">
      <div className="canvas-header">
        <span className="canvas-title">TaskFlow Canvas</span>
        <span className="canvas-epic-id">{epicId}</span>
      </div>
      
      <div className="canvas-zones">
        <HistoryZone 
          title="📜 历史循环" 
          loops={allHistory} 
          selectedLoopId={selectedLoopId}
          onSelectLoop={onSelectLoop}
        />
        
        <RunningZone 
          title="⚡ 正在执行" 
          loop={runningLoop}
          selectedLoopId={selectedLoopId}
          onSelectLoop={onSelectLoop}
        />
        
        <QueueZone 
          title="⏳ 排队等待" 
          loops={queue}
          selectedLoopId={selectedLoopId}
          onSelectLoop={onSelectLoop}
        />
      </div>
    </div>
  );
};
