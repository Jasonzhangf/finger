/**
 * Workflow Persistence - 工作流持久化与恢复
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Workflow, TaskNode } from './workflow-manager.js';

const FINGER_HOME = path.join(os.homedir(), '.finger');
const WORKFLOWS_DIR = path.join(FINGER_HOME, 'workflows');

interface SerializedWorkflow {
  id: string;
  sessionId: string;
  epicId?: string;
  tasks: Array<[string, TaskNode]>;
  status: Workflow['status'];
  createdAt: string;
  updatedAt: string;
}

function ensureDir(): void {
  if (!fs.existsSync(FINGER_HOME)) {
    fs.mkdirSync(FINGER_HOME, { recursive: true });
  }
  if (!fs.existsSync(WORKFLOWS_DIR)) {
    fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  }
}

function getWorkflowPath(workflowId: string): string {
  return path.join(WORKFLOWS_DIR, `${workflowId}.json`);
}

/**
 * 保存工作流到磁盘
 */
export function saveWorkflow(workflow: Workflow): void {
  ensureDir();
  const serialized: SerializedWorkflow = {
    id: workflow.id,
    sessionId: workflow.sessionId,
    epicId: workflow.epicId,
    tasks: Array.from(workflow.tasks.entries()),
    status: workflow.status,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
  const filePath = getWorkflowPath(workflow.id);
  fs.writeFileSync(filePath, JSON.stringify(serialized, null, 2));
}

/**
 * 从磁盘加载工作流
 */
export function loadWorkflow(workflowId: string): Workflow | null {
  const filePath = getWorkflowPath(workflowId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const serialized = JSON.parse(content) as SerializedWorkflow;
    return {
      ...serialized,
      tasks: new Map(serialized.tasks),
    };
  } catch (err) {
    console.error(`[WorkflowPersistence] Failed to load ${workflowId}:`, err);
    return null;
  }
}

/**
 * 加载所有未完成的工作流
 */
export function loadAllWorkflows(): Workflow[] {
  ensureDir();
  if (!fs.existsSync(WORKFLOWS_DIR)) {
    return [];
  }
  const workflows: Workflow[] = [];
  const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const workflowId = file.replace('.json', '');
    const workflow = loadWorkflow(workflowId);
    if (workflow && !isWorkflowCompleted(workflow)) {
      workflows.push(workflow);
    }
  }
  return workflows;
}

/**
 * 删除工作流文件
 */
export function deleteWorkflowFile(workflowId: string): void {
  const filePath = getWorkflowPath(workflowId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * 检查工作流是否已完成
 */
export function isWorkflowCompleted(workflow: Workflow): boolean {
  return workflow.status === 'completed' || workflow.status === 'failed';
}

/**
 * 检查任务是否超时
 */
export function isTaskTimeout(task: TaskNode): boolean {
  if (task.status !== 'in_progress' || !task.startedAt || !task.deadline) {
    return false;
  }
  const started = new Date(task.startedAt).getTime();
  const now = Date.now();
  return now - started > task.deadline;
}

export { WORKFLOWS_DIR };
