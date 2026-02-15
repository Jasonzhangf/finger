import { useMemo } from 'react';
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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './OrchestrationCanvas.css';
import { useAgents } from '../../hooks/useAgents.js';

type AgentNodeData = {
  name: string;
  role: string;
  status: 'idle' | 'running' | 'error';
  load: number;
  errorRate: number;
};

const AgentNodeComponent = ({ data }: { data: AgentNodeData }) => (
  <div className={`agent-node agent-node-${data.role}`}>
    <div className="agent-node-header">
      <span className={`status-dot status-${data.status}`} />
      <span className="agent-name">{data.name}</span>
    </div>
    <div className="agent-node-body">
      <div className="agent-role">{data.role}</div>
      <div className="agent-stats">
        <span>Load: {data.load}%</span>
        <span>Err: {data.errorRate}%</span>
      </div>
    </div>
  </div>
);

const nodeTypes = {
  agent: AgentNodeComponent,
};

const getRolePosition = (index: number, total: number, role: string): { x: number; y: number } => {
  if (role === 'orchestrator') {
    return { x: 400, y: 50 };
  }
  const layer = role === 'executor' ? 1 : 2;
  const layerY = 50 + layer * 150;
  const spacing = 800 / (total + 1);
  return { x: spacing * (index + 1), y: layerY };
};

const getRoleType = (name: string): string => {
  const n = name.toLowerCase();
  if (n.includes('orchestrator')) return 'orchestrator';
  if (n.includes('executor')) return 'executor';
  if (n.includes('reviewer')) return 'reviewer';
  return 'other';
};

export const OrchestrationCanvas = () => {
  const { agents, isLoading } = useAgents();

  const initialNodes: Node<AgentNodeData>[] = useMemo(() => {
    return agents.map((agent, idx) => ({
      id: agent.id,
      type: 'agent',
      position: getRolePosition(idx, agents.length, getRoleType(agent.name)),
      data: {
        name: agent.name,
        role: (agent.metadata?.type as string) || agent.type,
        status: agent.status,
        load: agent.load,
        errorRate: agent.errorRate,
      },
    }));
  }, [agents]);

  const initialEdges: Edge[] = useMemo(() => {
    const orchestrator = agents.find((a) => a.name.toLowerCase().includes('orchestrator'));
    if (!orchestrator) return [];

    return agents
      .filter((a) => a.id !== orchestrator.id)
      .map((agent) => ({
        id: `e-${orchestrator.id}-${agent.id}`,
        source: orchestrator.id,
        target: agent.id,
        animated: true,
        style: { stroke: '#4a5568' },
        markerEnd: { type: MarkerType.ArrowClosed },
      }));
  }, [agents]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  if (isLoading) {
    return (
      <div className="canvas-wrapper">
        <div className="canvas-loading">Loading agents...</div>
      </div>
    );
  }

  return (
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
    </div>
  );
};
