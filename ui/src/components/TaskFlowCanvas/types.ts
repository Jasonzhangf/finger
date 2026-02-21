export interface Loop {
  id: string;
  epicId: string;
  phase: 'plan' | 'design' | 'execution';
  status: 'queue' | 'running' | 'history';
  result?: 'success' | 'failed';
  nodes: LoopNode[];
  createdAt: string;
  completedAt?: string;
  sourceLoopId?: string;
}

export interface LoopNode {
  id: string;
  type: 'orch' | 'review' | 'exec' | 'user';
  status: 'waiting' | 'running' | 'done' | 'failed';
  title: string;
  text: string;
  agentId?: string;
  userId?: string;
  timestamp: string;
  resourceAllocation?: {
    allocated: string[];
    released?: string[];
  };
}

export type LoopResult = 'success' | 'failed' | undefined;

export interface TaskFlowCanvasProps {
  epicId: string;
  planHistory: Loop[];
  designHistory: Loop[];
  executionHistory: Loop[];
  runningLoop?: Loop;
  queue: Loop[];
  selectedLoopId?: string;
  onSelectLoop?: (loopId: string) => void;
}

export interface ZoneProps {
  title: string;
  loops: Loop[];
  selectedLoopId?: string;
  onSelectLoop?: (loopId: string) => void;
}

export interface LoopRowProps {
  loop: Loop;
  selected: boolean;
  onSelect: () => void;
}

export const getNodeColor = (type: 'orch' | 'review' | 'exec' | 'user'): string => {
  switch (type) {
    case 'orch': return '#5da8ff';
    case 'review': return '#bb86fc';
    case 'exec': return '#39d98a';
    case 'user': return '#ffb648';
    default: return '#8a93a8';
  }
};

export const getNodeStatusClass = (status: 'waiting' | 'running' | 'done' | 'failed'): string => {
  switch (status) {
    case 'running': return 'running';
    case 'done': return 'done';
    case 'failed': return 'failed';
    default: return 'waiting';
  }
};

export const getLoopResultClass = (result?: LoopResult): string => {
  if (!result) return '';
  return result === 'success' ? 'success' : 'failed';
};
