import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
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
import { RoundDetailModal } from '../RoundDetailModal/RoundDetailModal.js';
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
        {agent.instanceCount && agent.instanceCount > 1 && (
          <span className="instance-badge">x{agent.instanceCount}</span>
        )}
      </div>

      <div className="agent-node-body">
        <div className="agent-type">{agent.type}</div>
        <div className="agent-metrics">
          <span>Load {agent.load}%</span>
          <span>Error {agent.errorRate}%</span>
        </div>
        {agent.currentTaskId && <div className="current-task">Task: {agent.currentTaskId}</div>}
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
  inspectRequest,
  userRounds,
  selectedRoundId,
  executionRounds,
}: OrchestrationCanvasProps) => {
  const [selectedAgent, setSelectedAgent] = useState<AgentRuntime | null>(null);
  const roundModalTrigger = useRef<number>(0);
  const [selectedRound, setSelectedRound] = useState<UserRound | null>(null);
  const [showExecutionModal, setShowExecutionModal] = useState(false);
  const [showRoundModal, setShowRoundModal] = useState(false);
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
      position: { x: 460, y: 20 },
      data: { label: 'Start', stage: 'start' },
      draggable: false,
    });

    let currentY = 105;

    if (userRounds && userRounds.length > 0) {
      userRounds.forEach((round, idx) => {
        const yPos = currentY + idx * 95;
        list.push({
          id: round.roundId,
          type: 'stage',
          position: { x: 460, y: yPos },
          data: {
            label: `Round ${idx + 1}`,
            stage: 'input',
            summary: round.summary,
            timestamp: round.timestamp,
            roundId: round.roundId,
          },
          draggable: false,
          className: `clickable-round${selectedRoundId === round.roundId ? ' selected-round-node' : ''}`,
        });
      });
      currentY = 105 + userRounds.length * 95;
    } else {
      list.push({
        id: 'stage-input',
        type: 'stage',
        position: { x: 460, y: currentY },
        data: { label: 'User Input', stage: 'input' },
        draggable: false,
      });
      currentY += 95;
    }

    const orchestrators = agents.filter((agent) => agent.type === 'orchestrator');
    const others = agents.filter((agent) => agent.type !== 'orchestrator');

    const baseY = currentY;

    orchestrators.forEach((agent, idx) => {
      list.push({
        id: agent.id,
        type: 'agent',
        position: { x: 360 + idx * 220, y: baseY + 20 },
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

    others.forEach((agent, idx) => {
      const col = idx % 3;
      const row = Math.floor(idx / 3);
      list.push({
        id: agent.id,
        type: 'agent',
        position: { x: 140 + col * 320, y: baseY + 200 + row * 200 },
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

    if (executionState && (executionState.status === 'completed' || executionState.status === 'failed')) {
      const endY = baseY + 200 + Math.ceil(others.length / 3) * 200 + 80;
      list.push({
        id: 'stage-end',
        type: 'stage',
        position: { x: 460, y: endY },
        data: { label: executionState.status === 'completed' ? 'Completed' : 'Failed', stage: 'end' },
        draggable: false,
      });
    }

    return list;
  }, [agents, executionState, getAgentDetail, onSelectAgent, selectedAgentId, userRounds, selectedRoundId, executionRounds]);

  const computedEdges: Edge[] = useMemo(() => {
    if (!executionState) return [];

    const list: Edge[] = [];
    const orchestrator = agents.find((agent) => agent.type === 'orchestrator');

    const roundIds = userRounds && userRounds.length > 0 ? userRounds.map((r) => r.roundId) : ['stage-input'];
    const inputNodeId = roundIds[roundIds.length - 1];

    list.push({
      id: 'e-start-input',
      source: 'stage-start',
      target: roundIds[0],
      style: { stroke: '#64748b', strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed },
      className: 'edge-pending',
      animated: false,
    });

    for (let i = 0; i + 1 < roundIds.length; i++) {
      list.push({
        id: `e-round-${roundIds[i]}-${roundIds[i + 1]}`,
        source: roundIds[i],
        target: roundIds[i + 1],
        style: { stroke: '#64748b', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed },
        className: 'edge-pending',
        animated: false,
      });
    }

    if (orchestrator) {
      list.push({
        id: 'e-input-orchestrator',
        source: inputNodeId,
        target: orchestrator.id,
        style: { stroke: '#3b82f6', strokeWidth: 2.5 },
        markerEnd: { type: MarkerType.ArrowClosed },
        className: executionState.status === 'planning' || executionState.status === 'executing' ? 'edge-active' : 'edge-pending',
        animated: executionState.status === 'planning' || executionState.status === 'executing',
      });
    }

    // 如果没有 userRounds，确保 stage-input 连接到 orchestrator
    if (!userRounds || userRounds.length === 0) {
      if (orchestrator) {
        list.push({
          id: 'e-input-orchestrator',
          source: 'stage-input',
          target: orchestrator.id,
          style: { stroke: '#3b82f6', strokeWidth: 2.5 },
          markerEnd: { type: MarkerType.ArrowClosed },
          className: executionState.status === 'planning' || executionState.status === 'executing' ? 'edge-active' : 'edge-pending',
          animated: executionState.status === 'planning' || executionState.status === 'executing',
        });
      }
    }

    for (const path of executionState.executionPath) {
      const stroke =
        path.status === 'error'
          ? '#ef4444'
          : path.status === 'completed'
          ? '#10b981'
          : path.status === 'active'
          ? '#f59e0b'
          : '#3b82f6';

      list.push({
        id: `e-path-${path.from}-${path.to}-${path.status}`,
        source: path.from,
        target: path.to,
        style: { stroke, strokeWidth: path.status === 'active' ? 3 : 2 },
        markerEnd: { type: MarkerType.ArrowClosed },
        className: edgeClassByStatus(path.status),
        animated: path.status === 'active',
        label: path.message,
        labelStyle: { fill: '#dbeafe', fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: '#0f172a', fillOpacity: 0.92 },
        labelBgPadding: [7, 4],
        labelBgBorderRadius: 4,
      });
    }

    if (orchestrator) {
      for (const agent of agents.filter((item) => item.type === 'executor')) {
        const status =
          agent.status === 'running'
            ? 'active'
            : agent.status === 'error'
            ? 'error'
            : agent.status === 'idle'
            ? 'pending'
            : 'pending';

        const stroke = status === 'active' ? '#10b981' : status === 'error' ? '#ef4444' : '#3b82f6';

        list.push({
          id: `e-orch-${agent.id}`,
          source: orchestrator.id,
          target: agent.id,
          style: { stroke, strokeWidth: status === 'active' ? 3 : 2 },
          markerEnd: { type: MarkerType.ArrowClosed },
          className: edgeClassByStatus(status),
          animated: status === 'active',
          label: status === 'active' ? 'Running' : status === 'error' ? 'Error' : 'Pending',
          labelStyle: { fill: '#cbd5e1', fontSize: 10, fontWeight: 600 },
          labelBgStyle: { fill: '#0f172a', fillOpacity: 0.88 },
          labelBgPadding: [6, 3],
          labelBgBorderRadius: 4,
        });
      }
    }

    if (executionState.status === 'completed' || executionState.status === 'failed') {
      const endStroke = executionState.status === 'completed' ? '#10b981' : '#ef4444';
      for (const agent of agents) {
        list.push({
          id: `e-${agent.id}-end`,
          source: agent.id,
          target: 'stage-end',
          style: { stroke: endStroke, strokeWidth: 2.5 },
          markerEnd: { type: MarkerType.ArrowClosed },
          className: executionState.status === 'completed' ? 'edge-completed' : 'edge-error',
          animated: false,
        });
      }
    }

    return list;
  }, [agents, executionState, userRounds]);

  useEffect(() => {
    setNodes(computedNodes);
  }, [computedNodes, setNodes]);

  useEffect(() => {
    setEdges(computedEdges);
  }, [computedEdges, setEdges]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    (window as unknown as Record<string, unknown>).openRoundDetail = (roundId: string) => {
      if (!userRounds) return false;
      const round = userRounds.find((r) => r.roundId === roundId);
      if (!round) return false;
      setSelectedRound(round);
      setShowRoundModal(true);
      roundModalTrigger.current += 1;
      return true;
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).openRoundDetail;
    };
  }, [userRounds]);

  useEffect(() => {
    if (inspectRequest && inspectRequest.agentId) {
      const target = agents.find((agent) => agent.id === inspectRequest.agentId);
      if (target) {
        setSelectedAgent(target);
        setExecutionDetail(getAgentDetail(inspectRequest.agentId));
        setShowExecutionModal(true);
      }
    }
 }, [inspectRequest, agents, getAgentDetail]);

  useEffect(() => {
    const handleNodeClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const nodeEl = target.closest('.clickable-round');
      if (!nodeEl) return;
      const roundId = nodeEl.getAttribute('data-id');
      if (!roundId || !userRounds) return;
      const round = userRounds.find((r) => r.roundId === roundId);
      if (round) {
        setSelectedRound(round);
        setShowRoundModal(true);
      }
    };
    const canvasRoot = document.querySelector('.canvas-wrapper');
    if (canvasRoot) {
      canvasRoot.addEventListener('click', handleNodeClick as EventListener);
      return () => canvasRoot.removeEventListener('click', handleNodeClick as EventListener);
    }
  }, [userRounds]);

  const handleDeploy = useCallback(
    async (config: unknown) => {
      await onDeployAgent(config);
      setShowConfigPanel(false);
    },
    [onDeployAgent]
  );

  const idleCount = agents.filter((agent) => agent.status === 'idle').length;
  const runningCount = agents.filter((agent) => agent.status === 'running').length;
  const errorCount = agents.filter((agent) => agent.status === 'error').length;

  return (
    <>
      <div className="canvas-wrapper">
        <div className="canvas-hud">
          <div className="canvas-title">Execution Topology</div>
          <div className="canvas-legend">
            <span className="legend-item legend-idle">Pending {idleCount}</span>
            <span className="legend-item legend-running">Running {runningCount}</span>
            <span className="legend-item legend-error">Error {errorCount}</span>
          </div>
        </div>

        <ResourcePoolPanel
          availableResources={availableResources.map((r) => ({ id: r.id, name: r.config.name, type: r.id.includes('orchestrator') ? 'orchestrator' : 'executor', status: r.status }))}
          deployedResources={deployedResources.map((r) => ({ id: r.id, name: r.config.name, type: r.id.includes('orchestrator') ? 'orchestrator' : 'executor', status: r.status }))}
          hidden={Boolean(executionState && executionState.tasks.length > 0)}
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
          attributionPosition="bottom-left"
        >
          <Controls />
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.1} color="#1f2937" />
        </ReactFlow>

        <div className="canvas-actions">
          {executionState && (
            <button className="action-btn report-btn" onClick={() => setShowTaskReport(true)}>
              Task Report
            </button>
          )}
        </div>
      </div>

      <ExecutionModal isOpen={showExecutionModal} onClose={() => setShowExecutionModal(false)} detail={executionDetail} />

      <RoundDetailModal isOpen={showRoundModal} onClose={() => setShowRoundModal(false)} round={selectedRound} />

      <AgentConfigPanel
        isOpen={showConfigPanel}
        onClose={() => setShowConfigPanel(false)}
        agent={selectedAgent as unknown as ModuleInfo | null}
        onDeploy={handleDeploy}
      />

      <TaskReport isOpen={showTaskReport} onClose={() => setShowTaskReport(false)} report={getTaskReport()} />
    </>
  );
};
