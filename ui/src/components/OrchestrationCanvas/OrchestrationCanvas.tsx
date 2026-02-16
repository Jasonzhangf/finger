import { useMemo, useState, useCallback } from 'react';
import {
  ReactFlow,
  type Node,
  type Edge,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  MarkerType,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './OrchestrationCanvas.css';
import type {
  AgentRuntime,
  WorkflowExecutionState,
  AgentExecutionDetail,
  ModuleInfo,
} from '../../api/types.js';
import { ExecutionModal } from '../ExecutionModal/ExecutionModal.js';
import { AgentConfigPanel } from '../AgentConfigPanel/AgentConfigPanel.js';
import { TaskReport } from '../TaskReport/TaskReport.js';
import type { TaskReport as TaskReportType } from '../../api/types.js';

type AgentNodeData = {
  agent: AgentRuntime;
  onClick: () => void;
  onDoubleClick: () => void;
};

type StartEndNodeData = {
  label: string;
  type: 'start' | 'end';
};

const AgentNodeComponent = ({ data }: { data: AgentNodeData }) => {
  const { agent, onClick, onDoubleClick } = data;
  
  const getStatusClass = (status: string) => {
    switch (status) {
      case 'running': return 'status-running';
      case 'error': return 'status-error';
      case 'paused': return 'status-paused';
      default: return 'status-idle';
    }
  };

  const isRunning = agent.status === 'running';

  return (
    <div 
      className={`agent-node ${getStatusClass(agent.status)}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {isRunning && <div className="agent-marquee" />}
      
      <Handle type="target" position={Position.Top} className="node-handle" />
      
      <div className="agent-node-header">
        <span className={`status-dot status-${agent.status}`} />
        <span className="agent-name">{agent.name}</span>
        {agent.instanceCount && agent.instanceCount > 1 && (
          <span className="instance-badge">×{agent.instanceCount}</span>
        )}
      </div>
      
      <div className="agent-node-body">
        <div className="agent-type">{agent.type}</div>
        <div className="agent-metrics">
          <span>Load: {agent.load}%</span>
          <span>Err: {agent.errorRate}%</span>
        </div>
        {agent.currentTaskId && (
          <div className="current-task">
            ⏳ {agent.currentTaskId}
          </div>
        )}
      </div>
      
      <Handle type="source" position={Position.Bottom} className="node-handle" />
    </div>
  );
};

const StartEndNodeComponent = ({ data }: { data: StartEndNodeData }) => {
  const isStart = data.type === 'start';
  return (
    <div className={`start-end-node ${data.type}`}>
      <Handle 
        type={isStart ? 'source' : 'target'} 
        position={isStart ? Position.Bottom : Position.Top} 
        className="node-handle"
      />
      <div className="start-end-label">{data.label}</div>
    </div>
  );
};

const nodeTypes = {
  agent: AgentNodeComponent,
  startEnd: StartEndNodeComponent,
};

interface OrchestrationCanvasProps {
  executionState: WorkflowExecutionState | null;
  agents: AgentRuntime[];
  onDeployAgent: (agentConfig: any) => Promise<void>;
  getAgentDetail: (agentId: string) => AgentExecutionDetail | null;
  getTaskReport: () => TaskReportType | null;
}

export const OrchestrationCanvas = ({
  executionState,
  agents,
  onDeployAgent,
  getAgentDetail,
  getTaskReport,
}: OrchestrationCanvasProps) => {
  const [selectedAgent, setSelectedAgent] = useState<AgentRuntime | null>(null);
  const [showExecutionModal, setShowExecutionModal] = useState(false);
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [showTaskReport, setShowTaskReport] = useState(false);
  const [executionDetail, setExecutionDetail] = useState<AgentExecutionDetail | null>(null);

  const initialNodes: Node[] = useMemo(() => {
    const nodes: Node[] = [];
    
    nodes.push({
      id: 'start',
      type: 'startEnd',
      position: { x: 400, y: 20 },
      data: { label: '▶ 开始', type: 'start' },
    });

    agents.forEach((agent, idx) => {
      const row = Math.floor(idx / 3);
      const col = idx % 3;
      nodes.push({
        id: agent.id,
        type: 'agent',
        position: { x: 150 + col * 250, y: 120 + row * 180 },
        data: {
          agent,
          onClick: () => {
            setSelectedAgent(agent);
            const detail = getAgentDetail(agent.id);
            setExecutionDetail(detail);
            setShowExecutionModal(true);
          },
          onDoubleClick: () => {
            setSelectedAgent(agent);
            setShowConfigPanel(true);
          },
        },
      });
    });

    if (executionState && (executionState.status === 'completed' || executionState.status === 'failed')) {
      nodes.push({
        id: 'end',
        type: 'startEnd',
        position: { x: 400, y: 500 },
        data: { 
          label: executionState.status === 'completed' ? '✓ 完成' : '✗ 失败', 
          type: 'end' 
        },
      });
    }

    return nodes;
  }, [agents, executionState, getAgentDetail]);

  const initialEdges: Edge[] = useMemo(() => {
    const edges: Edge[] = [];
    
    if (!executionState) return edges;

    const orchestrator = agents.find(a => a.type === 'orchestrator');
    if (orchestrator) {
      edges.push({
        id: 'e-start-orchestrator',
        source: 'start',
        target: orchestrator.id,
        animated: executionState.status === 'executing' || executionState.status === 'planning',
        style: { stroke: '#60a5fa', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }

    executionState.executionPath.forEach((path, idx) => {
      const isActive = path.status === 'active';
      const isCompleted = path.status === 'completed';
      const hasError = path.status === 'error';
      
      edges.push({
        id: `e-${path.from}-${path.to}-${idx}`,
        source: path.from,
        target: path.to,
        animated: isActive,
        style: {
          stroke: hasError ? '#ef4444' : isCompleted ? '#10b981' : isActive ? '#f59e0b' : '#4b5563',
          strokeWidth: isActive ? 3 : 2,
        },
        markerEnd: { type: MarkerType.ArrowClosed },
        label: path.message,
        labelStyle: { fill: '#d1d5db', fontSize: 12 },
      });
    });

    if (orchestrator) {
      agents
        .filter(a => a.type === 'executor')
        .forEach((executor) => {
          const isExecuting = executor.status === 'running';
          const hasError = executor.status === 'error';
          
          edges.push({
            id: `e-${orchestrator.id}-${executor.id}`,
            source: orchestrator.id,
            target: executor.id,
            animated: isExecuting,
            style: {
              stroke: hasError ? '#ef4444' : isExecuting ? '#10b981' : '#4b5563',
              strokeWidth: isExecuting ? 3 : 2,
            },
            markerEnd: { type: MarkerType.ArrowClosed },
          });
        });
    }

    if (executionState.status === 'completed' || executionState.status === 'failed') {
      agents.forEach(agent => {
        edges.push({
          id: `e-${agent.id}-end`,
          source: agent.id,
          target: 'end',
          animated: false,
          style: {
            stroke: executionState.status === 'completed' ? '#10b981' : '#ef4444',
            strokeWidth: 2,
          },
          markerEnd: { type: MarkerType.ArrowClosed },
        });
      });
    }

    return edges;
  }, [agents, executionState]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  const handleDeploy = useCallback(async (config: any) => {
    await onDeployAgent(config);
    setShowConfigPanel(false);
  }, [onDeployAgent]);

  return (
    <>
      <div className="canvas-wrapper">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          attributionPosition="bottom-left"
        >
          <Controls />
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        </ReactFlow>

        <div className="canvas-actions">
          {executionState && (
            <button 
              className="action-btn report-btn"
              onClick={() => setShowTaskReport(true)}
            >
              📊 任务报告
            </button>
          )}
        </div>
      </div>

      <ExecutionModal
        isOpen={showExecutionModal}
        onClose={() => setShowExecutionModal(false)}
        detail={executionDetail}
      />

      <AgentConfigPanel
        isOpen={showConfigPanel}
        onClose={() => setShowConfigPanel(false)}
        agent={selectedAgent as unknown as ModuleInfo | null}
        onDeploy={handleDeploy}
      />

      <TaskReport
        isOpen={showTaskReport}
        onClose={() => setShowTaskReport(false)}
        report={getTaskReport()}
      />
    </>
  );
};
