/**
 * Assertion Engine for E2E Multi-Agent Tests
 * 
 * Provides automated assertions based on observer data
 * and generates test reports.
 * Task: finger-280.7
 */

import { logger } from '../../../src/core/logger.js';
import type { ResourceObserver, MemorySample } from '../observers/resource-observer.js';
import type { RegistryObserver } from '../observers/registry-observer.js';
import type { MailboxObserver } from '../observers/mailbox-observer.js';
import type { LedgerObserver } from '../observers/ledger-observer.js';
import type { ToolCallRecord } from '../../../src/test-support/tool-call-hook.js';

const log = logger.module('AssertionEngine');

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface AssertionResult {
  name: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  durationMs: number;
  error?: string;
}

export interface EventTimelineEntry {
  timestamp: number;
  event: string;
  details: Record<string, unknown>;
}

export interface TestReport {
  scenario: string;
  prompt: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  timeline: EventTimelineEntry[];
  assertions: AssertionResult[];
  memorySnapshot: MemorySample[];
  resourceGrowthMB: number;
  passed: boolean;
  summary: string;
}

export interface AssertionEngineConfig {
  defaultTimeoutMs?: number;
  deadlockThresholdMs?: number;
  pollIntervalMs?: number;
}

// ─────────────────────────────────────────────────────────────
// Assertion Engine
// ─────────────────────────────────────────────────────────────

export class AssertionEngine {
  private readonly config: Required<AssertionEngineConfig>;
  private readonly assertions: AssertionResult[] = [];
  private readonly timeline: EventTimelineEntry[] = [];
  private startedAt = 0;

  constructor(config: AssertionEngineConfig = {}) {
    this.config = {
      defaultTimeoutMs: config.defaultTimeoutMs ?? 30000,
      deadlockThresholdMs: config.deadlockThresholdMs ?? 60000,
      pollIntervalMs: config.pollIntervalMs ?? 200,
    };
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  start(scenarioName: string): void {
    this.startedAt = Date.now();
    this.assertions.length = 0;
    this.timeline.length = 0;
    this.recordEvent('test_started', { scenario: scenarioName });
    log.info('AssertionEngine started', { scenario: scenarioName });
  }

  // ─── Timeline ────────────────────────────────────────────────

  recordEvent(event: string, details: Record<string, unknown> = {}): void {
    this.timeline.push({ timestamp: Date.now(), event, details });
  }

  getTimeline(): EventTimelineEntry[] {
    return [...this.timeline];
  }

  // ─── Core Assertions ─────────────────────────────────────────

  /**
   * Generic wait for condition with timeout
   */
  async waitForCondition(
    name: string,
    condition: () => boolean,
    timeoutMs?: number
  ): Promise<AssertionResult> {
    const start = Date.now();
    const timeout = timeoutMs ?? this.config.defaultTimeoutMs;
    
    while (Date.now() - start < timeout) {
      if (condition()) {
        const result: AssertionResult = {
          name,
          passed: true,
          durationMs: Date.now() - start,
        };
        this.assertions.push(result);
        return result;
      }
      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }

    const result: AssertionResult = {
      name,
      passed: false,
      durationMs: Date.now() - start,
      error: `Timeout after ${timeout}ms`,
    };
    this.assertions.push(result);
    return result;
  }

  // ─── Pre-built Assertion Helpers ──────────────────────────────

  /**
   * Assert that N agents were spawned
   */
  async assertAgentSpawned(
    registryObs: RegistryObserver,
    expectedCount: number,
    timeoutMs?: number
  ): Promise<AssertionResult> {
    return this.waitForCondition(
      `agent_spawned(${expectedCount})`,
      () => registryObs.getActiveAgents().length >= expectedCount,
      timeoutMs
    );
  }

  /**
   * Assert concurrent execution
   */
  async assertConcurrentExecution(
    registryObs: RegistryObserver,
    minAgents: number,
    timeoutMs?: number
  ): Promise<AssertionResult> {
    return this.waitForCondition(
      `concurrent_execution(${minAgents})`,
      () => {
        const agents = registryObs.getActiveAgents();
        return agents.filter(a => a.status === 'active').length >= minAgents;
      },
      timeoutMs
    );
  }

  /**
   * Assert completion notification received
   */
  async assertCompletionReceived(
    mailboxObs: MailboxObserver,
    childId: string,
    timeoutMs?: number
  ): Promise<AssertionResult> {
    return this.waitForCondition(
      `completion_received(${childId})`,
      () => {
        const msgs = mailboxObs.getNewMessages();
        return msgs.some(m => 
          m.payload?.category === 'agent_completion' && 
          m.payload?.childId === childId
        );
      },
      timeoutMs
    );
  }

  /**
   * Assert memory growth under threshold
   */
  assertMemoryGrowthUnder(
    resourceObs: ResourceObserver,
    thresholdMB: number
  ): AssertionResult {
    const start = Date.now();
    try {
      resourceObs.assertMemoryGrowthLessThan(thresholdMB);
      const result: AssertionResult = {
        name: `memory_growth_under(${thresholdMB}MB)`,
        passed: true,
        durationMs: Date.now() - start,
      };
      this.assertions.push(result);
      return result;
    } catch (err) {
      const result: AssertionResult = {
        name: `memory_growth_under(${thresholdMB}MB)`,
        passed: false,
        durationMs: Date.now() - start,
        error: (err as Error).message,
      };
      this.assertions.push(result);
      return result;
    }
  }

  /**
   * Assert deadlock (no progress for N seconds)
   */
  async assertNoDeadlock(
    ledgerObs: LedgerObserver,
    timeoutMs?: number
  ): Promise<AssertionResult> {
    const start = Date.now();
    const threshold = timeoutMs ?? this.config.deadlockThresholdMs;
    let lastEventCount = ledgerObs.getNewEvents().length;
    let lastProgressAt = Date.now();

    while (Date.now() - start < threshold) {
      const currentCount = ledgerObs.getNewEvents().length;
      if (currentCount > lastEventCount) {
        lastEventCount = currentCount;
        lastProgressAt = Date.now();
      }
      
      if (Date.now() - lastProgressAt > threshold) {
        const result: AssertionResult = {
          name: 'no_deadlock',
          passed: false,
          durationMs: Date.now() - start,
          error: `No progress for ${threshold}ms`,
        };
        this.assertions.push(result);
        return result;
      }
      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }

    const result: AssertionResult = {
      name: 'no_deadlock',
      passed: true,
      durationMs: Date.now() - start,
    };
    this.assertions.push(result);
    return result;
  }

  // ─── Report Generation ───────────────────────────────────────

  /**
   * Generate test report
   */
  generateReport(
    scenario: string,
    prompt: string,
    resourceObs?: ResourceObserver
  ): TestReport {
    const completedAt = Date.now();
    const durationMs = completedAt - this.startedAt;
    const passed = this.assertions.length > 0 && this.assertions.every(a => a.passed);
    
    const memorySnapshot = resourceObs?.getMemoryTimeline() ?? [];
    const firstSample = memorySnapshot[0];
    const lastSample = memorySnapshot[memorySnapshot.length - 1];
    const resourceGrowthMB = firstSample && lastSample
      ? (lastSample.heapUsed - firstSample.heapUsed) / 1024 / 1024
      : 0;

    const report: TestReport = {
      scenario,
      prompt,
      startedAt: this.startedAt,
      completedAt,
      durationMs,
      timeline: this.timeline,
      assertions: [...this.assertions],
      memorySnapshot,
      resourceGrowthMB,
      passed,
      summary: this.generateSummary(passed, durationMs),
    };

    log.info('Test report generated', { scenario, passed, durationMs });
    return report;
  }

  private generateSummary(passed: boolean, durationMs: number): string {
    const total = this.assertions.length;
    const passedCount = this.assertions.filter(a => a.passed).length;
    const failedCount = total - passedCount;
    const status = passed ? '✅ PASSED' : '❌ FAILED';
    
    return `${status} | ${passedCount}/${total} assertions passed | ${failedCount} failed | ${durationMs}ms`;
  }

  /**
   * Get all assertion results
   */
  getAssertions(): AssertionResult[] {
    return [...this.assertions];
  }

  /**
   * Reset engine state
   */
  reset(): void {
    this.assertions.length = 0;
    this.timeline.length = 0;
    this.startedAt = 0;
  }
}
