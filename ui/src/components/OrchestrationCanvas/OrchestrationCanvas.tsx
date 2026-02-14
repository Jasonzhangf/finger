import React from 'react';
import './OrchestrationCanvas.css';

interface AgentNode {
  id: string;
  name: string;
  role: 'orchestrator' | 'executor' | 'reviewer' | 'architect' | 'tester';
  status: 'idle' | 'running' | 'completed' | 'error';
  position: { x: number; y: number };
}

export const OrchestrationCanvas: React.FC = () => {
  const nodes: AgentNode[] = [
    { id: 'orch-1', name: 'Orchestrator', role: 'orchestrator', status: 'running', position: { x: 300, y: 50 } },
    { id: 'exec-1', name: 'Executor 1', role: 'executor', status: 'running', position: { x: 150, y: 200 } },
    { id: 'exec-2', name: 'Executor 2', role: 'executor', status: 'completed', position: { x: 450, y: 200 } },
    { id: 'rev-1', name: 'Reviewer', role: 'reviewer', status: 'idle', position: { x: 600, y: 350 } },
    { id: 'test-1', name: 'Tester', role: 'tester', status: 'error', position: { x: 150, y: 350 } },
  ];

  const edges = [
    { from: 'orch-1', to: 'exec-1' },
    { from: 'orch-1', to: 'exec-2' },
    { from: 'exec-1', to: 'test-1' },
    { from: 'exec-2', to: 'rev-1' },
  ];

  const getRoleColor = (role: AgentNode['role']) => {
    switch (role) {
      case 'orchestrator': return '#9b59b6';
      case 'executor': return '#3498db';
      case 'reviewer': return '#2ecc71';
      case 'architect': return '#f1c40f';
      case 'tester': return '#e67e22';
    }
  };

  const getStatusColor = (status: AgentNode['status']) => {
    switch (status) {
      case 'idle': return '#6b7280';
      case 'running': return '#3b82f6';
      case 'completed': return '#10b981';
      case 'error': return '#ef4444';
    }
  };

  return (
    <div className="canvas-wrapper">
      <div className="canvas-placeholder-text">
        Orchestration Canvas (React Flow placeholder)
      </div>
      <svg className="canvas-svg" viewBox="0 0 800 500">
        {/* Edges */}
        {edges.map((edge, idx) => {
          const fromNode = nodes.find(n => n.id === edge.from);
          const toNode = nodes.find(n => n.id === edge.to);
          if (!fromNode || !toNode) return null;
          return (
            <line
              key={idx}
              x1={fromNode.position.x}
              y1={fromNode.position.y + 40}
              x2={toNode.position.x}
              y2={toNode.position.y}
              stroke="#4a5568"
              strokeWidth="2"
              markerEnd="url(#arrow)"
            />
          );
        })}
        
        {/* Arrow marker */}
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#4a5568" />
          </marker>
        </defs>

        {/* Nodes */}
        {nodes.map((node) => (
          <g key={node.id} transform={`translate(${node.position.x}, ${node.position.y})`}>
            <rect
              x="-60"
              y="0"
              width="120"
              height="80"
              rx="8"
              fill="#1a1f2a"
              stroke={getRoleColor(node.role)}
              strokeWidth="2"
              className="node-rect"
            />
            <circle
              cx="40"
              cy="10"
              r="6"
              fill={getStatusColor(node.status)}
            />
            <text x="0" y="30" textAnchor="middle" fill="#e4e7eb" fontSize="12" fontWeight="500">
              {node.name}
            </text>
            <text x="0" y="50" textAnchor="middle" fill="#9aa4b5" fontSize="10">
              {node.role}
            </text>
            <text x="0" y="68" textAnchor="middle" fill="#6b7280" fontSize="9">
              {node.status}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
};
