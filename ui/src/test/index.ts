/**
 * UI 自测系统 - 统一 API 接口和状态管理
 * 与编排 app 统一状态，建立自动化测试系统
 */

// 类型定义
export interface TestAPI {
  startServer(): Promise<void>;
  stopServer(): Promise<void>;
  resetState(): Promise<void>;
  sendUserInput(text: string): Promise<void>;
  waitForAgentResponse(timeout?: number): Promise<RuntimeEvent[]>;
  getExecutionState(): Promise<WorkflowExecutionState>;
  subscribeToEvents(callback: (event: RuntimeEvent) => void): () => void;
  waitForWorkflowStatus(status: string, timeout?: number): Promise<boolean>;
  listAgents(): Promise<AgentState[]>;
}

export interface RuntimeEvent {
  id: string;
  type: string;
  role: 'user' | 'agent' | 'system';
  agentId?: string;
  agentName?: string;
 kind: 'thought' | 'action' | 'observation' | 'status';
  content?: string;
  timestamp: string;
  round?: number;
  status?: 'pending' | 'confirmed' | 'error';
}

export interface WorkflowExecutionState {
  sessionId: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
  currentRound: number;
  agents: AgentState[];
  userRounds: UserRound[];
}

export interface AgentState {
  id: string;
  name: string;
  status: 'idle' | 'working' | 'completed' | 'error';
  currentTask?: string;
}

export interface UserRound {
  roundNumber: number;
  userInput: string;
  agentResponses: AgentResponse[];
}

export interface AgentResponse {
  agentId: string;
  agentName: string;
  content: string;
  timestamp: number;
}

// 测试运行器接口
export interface TestRunner {
  runTestScenario(scenario: TestScenario): Promise<TestResult>;
  setupTestEnvironment(): Promise<void>;
  cleanupTestEnvironment(): Promise<void>;
}

export interface TestScenario {
  name: string;
  steps: TestStep[];
  expectations: TestExpectation[];
}

export interface TestStep {
  action: 'sendInput' | 'waitForResponse' | 'pause' | 'resume' | 'stop';
  params?: Record<string, unknown>;
  delayMs?: number;
}

export interface TestExpectation {
  type: 'messageCount' | 'agentStatus' | 'workflowStatus' | 'eventType';
  selector?: string;
  expectedValue: unknown;
  timeoutMs?: number;
}

export interface TestResult {
  passed: boolean;
  scenario: string;
  steps: StepResult[];
  durationMs: number;
  error?: string;
}

export interface StepResult {
  step: number;
  action: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

// 导出具体实现
export { createTestAPI, testAPI } from './test-api.js';
export { createTestRunner, testRunner } from './test-runner.js';
export { DialogFlowTest } from './DialogFlowTest.js';
