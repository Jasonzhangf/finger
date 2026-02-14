

export interface DecomposedTask {
  title: string;
  description: string;
  priority: number;
  isMainPath: boolean;
  dependencies: string[];
  assignedRole: 'orchestrator' | 'executor' | 'reviewer' | 'architect' | 'tester' | 'docwriter';
  acceptanceCriteria: string[];
}

export interface DecompositionResult {
  projectId: string;
  tasks: DecomposedTask[];
  summary: string;
}

export class TaskDecomposer {
  decompose(projectId: string, userTask: string): DecompositionResult {
    const tasks: DecomposedTask[] = [];

    const archTask: DecomposedTask = {
      title: `Design: ${userTask}`,
      description: `Design architecture for ${userTask}`,
      priority: 1,
      isMainPath: false,
      dependencies: [],
      assignedRole: 'architect',
      acceptanceCriteria: ['Architecture document created', 'API/interfaces defined']
    };
    tasks.push(archTask);

    const implTask: DecomposedTask = {
      title: `Implement: ${userTask}`,
      description: `Implement ${userTask} based on architecture`,
      priority: 0,
      isMainPath: true,
      dependencies: [archTask.title],
      assignedRole: 'executor',
      acceptanceCriteria: ['Code implemented', 'Tests passing']
    };
    tasks.push(implTask);

    const testTask: DecomposedTask = {
      title: `Test: ${userTask}`,
      description: `Write tests for ${userTask}`,
      priority: 1,
      isMainPath: false,
      dependencies: [implTask.title],
      assignedRole: 'tester',
      acceptanceCriteria: ['Unit tests written', 'Integration tests passing']
    };
    tasks.push(testTask);

    const reviewTask: DecomposedTask = {
      title: `Review: ${userTask}`,
      description: `Review implementation of ${userTask}`,
      priority: 1,
      isMainPath: false,
      dependencies: [implTask.title, testTask.title],
      assignedRole: 'reviewer',
      acceptanceCriteria: ['Code reviewed', 'Issues addressed']
    };
    tasks.push(reviewTask);

    return {
      projectId,
      tasks,
      summary: `Decomposed "${userTask}" into ${tasks.length} tasks`
    };
  }
}
