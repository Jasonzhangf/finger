/**
 * CLI HTTP/WebSocket client wrapper based on FingerClient SDK.
 */

import {
  FingerClient,
  type FingerClientOptions,
  type WorkflowState,
  type RuntimeEvent,
  type UserDecision,
  type AgentInfo,
} from '../client/finger-client.js';

export type { WorkflowState, RuntimeEvent, UserDecision, AgentInfo };

export interface OrchestrateOptions {
  sessionId?: string;
  blocking?: boolean;
}

export interface SendWorkflowInputOptions {
  workflowId: string;
  input: string;
}

export class CliClient {
  private client: FingerClient;

  constructor(options: FingerClientOptions = {}) {
    this.client = new FingerClient(options);
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  subscribeAll(handler: (event: RuntimeEvent) => void): () => void {
    return this.client.subscribeAll(handler);
  }

  onDecision(handler: (decision: UserDecision) => Promise<string>): void {
    this.client.onDecision(handler);
  }

  async orchestrate(task: string, options: OrchestrateOptions = {}): Promise<{ workflowId: string; messageId: string }> {
    return this.client.orchestrate(task, {
      sessionId: options.sessionId,
      blocking: options.blocking,
    });
  }

  async sendWorkflowInput(options: SendWorkflowInputOptions): Promise<void> {
    await this.client.sendInput(options.workflowId, options.input);
  }

  async pause(workflowId: string): Promise<void> {
    await this.client.pause(workflowId);
  }

  async resume(workflowId: string): Promise<void> {
    await this.client.resume(workflowId);
  }

  async getStatus(workflowId: string): Promise<WorkflowState> {
    return this.client.getStatus(workflowId);
  }

  async list(): Promise<WorkflowState[]> {
    return this.client.listWorkflows();
  }

  async listAgents(): Promise<AgentInfo[]> {
    return this.client.listAgents();
  }
}

export function createCliClient(options: FingerClientOptions = {}): CliClient {
  return new CliClient(options);
}
