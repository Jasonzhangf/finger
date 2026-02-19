import { useMemo, useState, useCallback, useEffect } from 'react';
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
  UserRound,
  ExecutionRound,
} from '../../api/types.js';
import { ExecutionModal } from '../ExecutionModal/ExecutionModal.js';
import { AgentConfigPanel } from '../AgentConfigPanel/AgentConfigPanel.js';
import { TaskReport } from '../TaskReport/TaskReport.js';
import { ResourcePoolPanel } from '../ResourcePoolPanel/ResourcePoolPanel.js';
import type { TaskReport as TaskReportType } from '../../api/types.js';
import { useResourcePool } from '../../hooks/useResourcePool.js';

type AgentNodeData = {
  agent: AgentRuntime;
  selected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
};

type StageNodeData = {
  label: string;
  stage: 'start' | 'input' | 'end';
  roundId?: string;
  summary?: string;
  timestamp?: string;
};

const AgentNodeComponent = ({ data }: { data: AgentNodeData }) => {
  const { agent, selected, onClick, onDoubleClick } = data;

  const statusClass =
    agent.status === 'running'
      ? 'status-running'
      : agent.status === 'error'
      ? 'status-error'
      : agent.status === 'paused'
      ? 'status-paused'
      : 'status-idle';

  return (
    <div className={`agent-node ${statusClass}${selected ? ' is-selected' : ''}`} onClick={onClick} onDoubleClick={onDoubleClick}>
      {agent.status === 'running' && <div className="agent-marquee" />}

      <Handle type="target" position={Position.Top} className="node-handle" />

      <div className="agent-node-header">
        <button type="button" className={`status-dot ${statusClass}`} aria-label="Agent status" />
        <span className="agent-name">{agent.name}</span>
      </div>

      <div className="agent-node-body">
        <div className="agent-type">{agent.type}</div>
        <div className="agent-metrics">
          <span>Load {agent.load}%</span>
          <span>Error {agent.errorRate}%</span>
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} className="node-handle" />
    </div>
  );
};

const StageNodeComponent = ({ data }: { data: StageNodeData }) => {
  return (
    <div className={`stage-node stage-${data.stage}`}>
      <Handle
        type={data.stage === 'end' ? 'target' : 'source'}
        position={data.stage === 'end' ? Position.Top : Position.Bottom}
        className="node-handle"
      />
      <div className="stage-label">
        {data.label}
        {data.summary && <div className="stage-summary">{data.summary}</div>}
      </div>
    </div>
  );
};

const nodeTypes = {
  agent: AgentNodeComponent,
  stage: StageNodeComponent,
};

interface OrchestrationCanvasProps {
  executionState: WorkflowExecutionState | null;
  agents: AgentRuntime[];
  userRounds?: UserRound[];
  executionRounds?: ExecutionRound[];
  onDeployAgent: (agentConfig: unknown) => Promise<void>;
  getAgentDetail: (agentId: string) => AgentExecutionDetail | null;
  getTaskReport: () => TaskReportType | null;
  selectedAgentId?: string | null;
  onSelectAgent?: (agentId: string | null) => void;
  inspectRequest?: { agentId: string; signal: number } | null;
  selectedRoundId?: string | null;
  onSelectRound?: (roundId: string | null) => void;
}

function edgeClassByStatus(status: 'active' | 'completed' | 'error' | 'pending'): string {
  if (status === 'active') return 'edge-active';
  if (status === 'completed') return 'edge-completed';
  if (status === 'error') return 'edge-error';
  return 'edge-pending';
}

export const OrchestrationCanvas = ({
  executionState,
  agents,
  onDeployAgent,
  getAgentDetail,
  getTaskReport,
  selectedAgentId,
  onSelectAgent,
}: OrchestrationCanvasProps) => {
  console.log('[OrchestrationCanvas] render:', { executionState, agents });
  
  const [selectedAgent, setSelectedAgent] = useState<AgentRuntime | null>(null);
  const [showExecutionModal, setShowExecutionModal] = useState(false);
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [showTaskReport, setShowTaskReport] = useState(false);
  const [executionDetail, setExecutionDetail] = useState<AgentExecutionDetail | null>(null);
  const { availableResources, deployedResources, deployResource, releaseResource } = useResourcePool();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const computedNodes: Node[] = useMemo(() => {
    const list: Node[] = [];
    
    list.push({
      id: 'stage-start',
      type: 'stage',
      position: { x: 200, y: 20 },
      data: { label: 'Start', stage: 'start' },
      draggable: false,
    });

    agents.forEach((agent, idx) => {
      list.push({
        id: agent.id,
        type: 'agent',
        position: { x: 100 + idx * 200, y: 150 },
        data: {
          agent,
          selected: selectedAgentId === agent.id,
          onClick: () => {
            setSelectedAgent(agent);
            onSelectAgent?.(agent.id);
            setExecutionDetail(getAgentDetail(agent.id));
            setShowExecutionModal(true);
          },
          onDoubleClick: () => {
            setSelectedAgent(agent);
            setShowConfigPanel(true);
          },
        },
      });
    });

    return list;
  }, [agents, executionState, getAgentDetail, onSelectAgent, selectedAgentId]);

  const computedEdges: Edge[] = useMemo(() => {
    if (!executionState) return [];
    return executionState.executionPath.map((path, idx) => ({
      id: `e-${idx}`,
      source: path.from,
      target: path.to,
      style: { stroke: '#3b82f6', strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed },
      className: edgeClassByStatus(path.status),
      animated: path.status === 'active',
      label: path.message,
    }));
  }, [executionState]);

  useEffect(() => {
    setNodes(computedNodes);
  }, [computedNodes, setNodes]);

  useEffect(() => {
    setEdges(computedEdges);
  }, [computedEdges, setEdges]);

  const handleDeploy = useCallback(
    async (config: unknown) => {
      await onDeployAgent(config);
      setShowConfigPanel(false);
    },
    [onDeployAgent]
  );

  if (!executionState) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: '#0e1217' }}>
        <div style={{ textAlign: 'center', color: '#9ca3af' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🎯</div>
          <div style={{ fontSize: '18px', marginBottom: '8px' }}>准备就绪</div>
          <div style={{ fontSize: '14px' }}>在右侧输入任务开始编排执行</div>
        </div>
      </div>
    );
  }

  return (
    <div className="canvas-wrapper">
      <div className="canvas-hud">
        <div className="canvas-title">Execution Topology</div>
      </div>

      <ResourcePoolPanel
        availableResources={availableResources.map((r) => ({ id: r.id, name: r.config?.name || r.id, type: r.id.includes('orchestrator') ? 'orchestrator' : 'executor', status: r.status }))}
        deployedResources={deployedResources.map((r) => ({ id: r.id, name: r.config?.name || r.id, type: r.id.includes('orchestrator') ? 'orchestrator' : 'executor', status: r.status }))}
        hidden={false}
        onDeploy={(resourceId) => {
          if (!executionState) return;
          void deployResource(resourceId, executionState.workflowId, executionState.workflowId);
        }}
        onRelease={(resourceId) => {
          void releaseResource(resourceId);
        }}
      />

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.5}
        maxZoom={1.4}
      >
        <Controls />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.1} color="#1f2937" />
      </ReactFlow>

      <ExecutionModal isOpen={showExecutionModal} onClose={() => setShowExecutionModal(false)} detail={executionDetail} />

      <AgentConfigPanel
        isOpen={showConfigPanel}
        onClose={() => setShowConfigPanel(false)}
        agent={selectedAgent as unknown as ModuleInfo | null}
        onDeploy={handleDeploy}
      />

      <TaskReport isOpen={showTaskReport} onClose={() => setShowTaskReport(false)} report={getTaskReport()} />
    </div>
  );
};
