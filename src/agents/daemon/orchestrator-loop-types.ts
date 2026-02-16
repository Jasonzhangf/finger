export interface TaskResult {
  taskId: string;
  success: boolean;
  output?: string;
  error?: string;
}

export interface OrchestrationState {
  phase: 'understanding' | 'planning' | 'executing' | 'reviewing' | 'completed' | 'failed';
  userTask: string;
  taskGraph: Array<{
    id: string;
    description: string;
    status: 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed';
    assignee?: string;
    result?: TaskResult;
    bdTaskId?: string;
  }>;
  completedTasks: string[];
  failedTasks: string[];
  round: number;
}
