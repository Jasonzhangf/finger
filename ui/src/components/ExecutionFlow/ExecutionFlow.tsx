import { useMemo } from 'react';
import {
  ReactFlow,
  type Node,
  type Edge,
  Controls,
  Background,
  BackgroundVariant,
  MarkerType,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { SessionLog } from '../../hooks/useExecutionLogs.js';

type AgentNodeData = {
  agentId: string;
  agentName: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  currentStep: number;
  totalSteps: number;
  latestAction?: string;
  thought?: string;
};

type EndNodeData = {
  status: 'success' | 'error';
};

const AgentNode = ({ data }: { data: AgentNodeData }) => {
  const { agentName, status, currentStep, totalSteps, latestAction } = data;
  
  const getStatusColor = () => {
    switch (status) {
      case 'running': return '#10b981';
      case 'completed': return '#3b82f6';
      case 'error': return '#ef4444';
      default: return '#6b7280';
    }
  };
  
  const isRunning = status === 'running';
  const progress = totalSteps > 0 ? (currentStep / totalSteps) * 100 : 0;
  
  return (
    <div
      style={{
        padding: '12px',
        borderRadius: '8px',
        background: '#1f2937',
        border: `2px solid ${getStatusColor()}`,
        minWidth: '180px',
        boxShadow: isRunning ? `0 0 15px ${getStatusColor()}40` : 'none',
        transition: 'all 0.3s ease',
        position: 'relative',
      }}
    >
      {isRunning && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '3px',
            background: `linear-gradient(90deg, transparent, ${getStatusColor()}, transparent)`,
            animation: 'marquee 2s linear infinite',
          }}
        />
      )}
      
      <Handle type="target" position={Position.Top} style={{ background: getStatusColor() }} />
      
      <div style={{ color: '#f3f4f6', fontWeight: 600, marginBottom: '4px' }}>
        {agentName}
      </div>
      
      <div style={{ color: getStatusColor(), fontSize: '12px', marginBottom: '8px' }}>
        {status === 'running' && '▶ 执行中'}
        {status === 'completed' && '✓ 完成'}
        {status === 'error' && '✗ 错误'}
        {status === 'idle' && '○ 空闲'}
      </div>
      
      {latestAction && (
        <div style={{ color: '#9ca3af', fontSize: '11px', marginBottom: '8px' }}>
          {latestAction}
        </div>
      )}
      
      {totalSteps > 0 && (
        <div>
          <div
            style={{
              height: '4px',
              background: '#374151',
              borderRadius: '2px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${progress}%`,
                background: getStatusColor(),
                transition: 'width 0.3s ease',
              }}
            />
          </div>
          <div style={{ color: '#9ca3af', fontSize: '10px', marginTop: '4px' }}>
            {currentStep} / {totalSteps}
          </div>
        </div>
      )}
      
      <Handle type="source" position={Position.Bottom} style={{ background: getStatusColor() }} />
    </div>
  );
};

const StartNode = () => (
  <div
    style={{
      width: '60px',
      height: '60px',
      borderRadius: '50%',
      background: 'linear-gradient(135deg, #10b981, #059669)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'white',
      fontWeight: 'bold',
      boxShadow: '0 4px 12px rgba(16, 185, 129, 0.4)',
    }}
  >
    ▶
  </div>
);

const EndNode = ({ data }: { data: EndNodeData }) => (
  <div
    style={{
      width: '60px',
      height: '60px',
      borderRadius: '50%',
      background: data.status === 'success' 
        ? 'linear-gradient(135deg, #3b82f6, #2563eb)'
        : 'linear-gradient(135deg, #ef4444, #dc2626)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'white',
      fontWeight: 'bold',
      boxShadow: `0 4px 12px ${data.status === 'success' ? 'rgba(59, 130, 246, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
    }}
  >
    {data.status === 'success' ? '✓' : '✗'}
  </div>
);

const nodeTypes = {
  agent: AgentNode,
  start: StartNode,
  end: EndNode,
};

interface ExecutionFlowProps {
  logs: SessionLog[];
}

export const ExecutionFlow: React.FC<ExecutionFlowProps> = ({ logs }) => {
  const nodes: Node[] = useMemo(() => {
    const list: Node[] = [];
    
    // Start node
    list.push({
      id: 'start',
      type: 'start',
      position: { x: 400, y: 20 },
      data: {},
    });
    
    // Agent nodes
    logs.forEach((log, idx) => {
      const row = Math.floor(idx / 3);
      const col = idx % 3;
      const latestIter = log.iterations?.[log.iterations.length - 1];
      
      let status: AgentNodeData['status'] = 'idle';
      if (!log.endTime && log.iterations?.length > 0) status = 'running';
      else if (log.success) status = 'completed';
      else if (log.finalError) status = 'error';
      
      list.push({
        id: log.agentId,
        type: 'agent',
        position: { x: 150 + col * 250, y: 120 + row * 180 },
        data: {
          agentId: log.agentId,
          agentName: log.agentId.split('-').pop() || log.agentId,
          status,
          currentStep: log.iterations?.length || 0,
          totalSteps: log.totalRounds || 5,
          latestAction: latestIter?.action,
          thought: latestIter?.thought?.slice(0, 100),
        } satisfies AgentNodeData,
      });
    });
    
    // End node if all completed
    const allDone = logs.length > 0 && logs.every(l => l.endTime);
    if (allDone) {
      const allSuccess = logs.every(l => l.success);
      list.push({
        id: 'end',
        type: 'end',
        position: { x: 400, y: 400 },
        data: { status: allSuccess ? 'success' : 'error' } satisfies EndNodeData,
      });
    }
    
    return list;
  }, [logs]);
  
  const edges: Edge[] = useMemo(() => {
    const list: Edge[] = [];
    
    if (logs.length === 0) return list;
    
    // Start to first agent
    if (logs[0]) {
      list.push({
        id: 'e-start-0',
        source: 'start',
        target: logs[0].agentId,
        animated: !logs[0].endTime,
        style: { stroke: '#10b981', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }
    
    // Sequential connections between agents
    for (let i = 0; i < logs.length - 1; i++) {
      const current = logs[i];
      const next = logs[i + 1];
      const isActive = !current.endTime;
      const isCompleted = !!current.endTime;
      
      list.push({
        id: `e-${current.agentId}-${next.agentId}`,
        source: current.agentId,
        target: next.agentId,
        animated: isActive,
        style: {
          stroke: isCompleted ? '#3b82f6' : isActive ? '#10b981' : '#4b5563',
          strokeWidth: isActive ? 3 : 2,
        },
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }
    
    // End connection
    const allDone = logs.every(l => l.endTime);
    if (allDone) {
      const last = logs[logs.length - 1];
      list.push({
        id: 'e-end',
        source: last.agentId,
        target: 'end',
        animated: false,
        style: {
          stroke: logs.every(l => l.success) ? '#3b82f6' : '#ef4444',
          strokeWidth: 2,
        },
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }
    
    return list;
  }, [logs]);
  
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        attributionPosition="bottom-left"
      >
        <Controls />
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      </ReactFlow>
      
      <style>{`
        @keyframes marquee {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
};
