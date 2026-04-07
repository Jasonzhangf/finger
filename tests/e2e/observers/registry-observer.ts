/**
 * Registry Observer for E2E tests
 * Observes agent registry for testing agent lifecycle and concurrency
 */

import { waitForCondition } from './utils.js';
import { logger } from '../../../src/core/logger.js';
import type { AgentMetadata, AgentRegistry } from '../../../src/orchestration/agent-registry.js';

const log = logger.module('RegistryObserver');

/**
 * Registry Observer
 * Monitors agent registry for active agents and their states
 */
export class RegistryObserver {
  private readonly registry: AgentRegistry;
  private snapshotCache: AgentMetadata[] = [];

  constructor(registry: AgentRegistry) {
    this.registry = registry;
    log.debug('RegistryObserver created');
  }

  /**
   * Get list of active agents
   */
  getActiveAgents(): AgentMetadata[] {
    const agents = this.registry.listAgents();
    this.snapshotCache = agents;
    return agents;
  }

  /**
   * Wait for agent count to reach expected number
   */
  async assertAgentCount(expected: number, timeoutMs: number): Promise<void> {
    await waitForCondition(
      () => {
        const agents = this.getActiveAgents();
        return agents.length === expected;
      },
      timeoutMs,
      `Expected ${expected} agents but found ${this.snapshotCache.length} within ${timeoutMs}ms`
    );
  }

  /**
   * Wait for concurrent execution (multiple agents running simultaneously)
   */
  async assertConcurrentExecution(minConcurrent: number, timeoutMs: number): Promise<void> {
    await waitForCondition(
      () => {
        const agents = this.getActiveAgents();
        const activeOrPending = agents.filter(
          a => a.status === 'active' || a.status === 'pending'
        );
        return activeOrPending.length >= minConcurrent;
      },
      timeoutMs,
      `Expected at least ${minConcurrent} concurrent agents within ${timeoutMs}ms`
    );
  }

  /**
   * Wait for specific agent to complete
   */
  async assertAgentCompleted(agentId: string, timeoutMs: number): Promise<void> {
    await waitForCondition(
      () => {
        const agents = this.getActiveAgents();
        const agent = agents.find(a => 
          a.agentId === agentId || 
          a.agentPath === agentId || 
          a.agentNickname === agentId
        );
        
        // Agent completed if it's closed or no longer exists
        if (!agent) return true; // Agent doesn't exist means it completed and was removed
        return agent.status === 'closed';
      },
      timeoutMs,
      `Agent "${agentId}" did not complete within ${timeoutMs}ms`
    );
  }

  /**
   * Get current snapshot of agents
   */
  getAgentSnapshot(): AgentMetadata[] {
    return [...this.snapshotCache];
  }

  /**
   * Wait for agent to reach a specific status
   */
  async assertAgentStatus(
    agentId: string, 
    status: AgentMetadata['status'], 
    timeoutMs: number
  ): Promise<void> {
    await waitForCondition(
      () => {
        const agents = this.getActiveAgents();
        const agent = agents.find(a => 
          a.agentId === agentId || 
          a.agentPath === agentId || 
          a.agentNickname === agentId
        );
        return agent?.status === status;
      },
      timeoutMs,
      `Agent "${agentId}" did not reach status "${status}" within ${timeoutMs}ms`
    );
  }

  /**
   * Wait for agent to be registered (appear in registry)
   */
  async assertAgentRegistered(agentId: string, timeoutMs: number): Promise<void> {
    await waitForCondition(
      () => {
        const agents = this.getActiveAgents();
        return agents.some(a => 
          a.agentId === agentId || 
          a.agentPath === agentId || 
          a.agentNickname === agentId
        );
      },
      timeoutMs,
      `Agent "${agentId}" was not registered within ${timeoutMs}ms`
    );
  }

  /**
   * Get agent by ID/path/nickname
   */
  findAgent(identifier: string): AgentMetadata | undefined {
    return this.snapshotCache.find(a => 
      a.agentId === identifier || 
      a.agentPath === identifier || 
      a.agentNickname === identifier
    );
  }

  /**
   * Get count of agents by status
   */
  getAgentCountByStatus(status: AgentMetadata['status']): number {
    return this.snapshotCache.filter(a => a.status === status).length;
  }

  /**
   * Reset snapshot cache
   */
  reset(): void {
    this.snapshotCache = [];
    log.debug('RegistryObserver reset');
  }
}
