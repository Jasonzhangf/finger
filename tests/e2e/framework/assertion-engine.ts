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
          m.category === 'completion' || 
          m.category === 'agent_completion' ||
          (m.content && typeof m.content === 'object' && 
           (m.content as Record<string, unknown>).completionStatus)
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
   * Uses sync version of getNewEvents since LedgerObserver returns Promise
   */
  async assertNoDeadlock(
    ledgerObs: LedgerObserver,
    timeoutMs?: number
  ): Promise<AssertionResult> {
    const start = Date.now();
    const threshold = timeoutMs ?? this.config.deadlockThresholdMs;
    
    // Use event cache for tracking progress (sync)
    let lastEventCount = ledgerObs.getEventTimeline().length;
    let lastProgressAt = Date.now();

    while (Date.now() - start < threshold) {
      // Poll for new events and check progress
      await ledgerObs.getNewEvents();
      const currentCount = ledgerObs.getEventTimeline().length;
      
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

  // ─── Cross-Observer Assertions ───────────────────────────────

  /**
   * Assert agent count matches mailbox notification count
   */
  async assertAgentCountMatchesNotifications(
    registryObs: RegistryObserver,
    mailboxObs: MailboxObserver,
    timeoutMs?: number
  ): Promise<AssertionResult> {
    const start = Date.now();
    const timeout = timeoutMs ?? this.config.defaultTimeoutMs;
    
    while (Date.now() - start < timeout) {
      const agents = registryObs.getActiveAgents();
      const msgs = mailboxObs.getNewMessages();
      const notifications = msgs.filter(
        m => m.category === 'completion' || m.category === 'agent_completion'
      );
      
      if (agents.length === notifications.length) {
        const result: AssertionResult = {
          name: 'agent_count_matches_notifications',
          passed: true,
          expected: agents.length,
          actual: notifications.length,
          durationMs: Date.now() - start,
        };
        this.assertions.push(result);
        return result;
      }
      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }

    const agents = registryObs.getActiveAgents();
    const msgs = mailboxObs.getNewMessages();
    const notifications = msgs.filter(
      m => m.category === 'completion' || m.category === 'agent_completion'
    );
    
    const result: AssertionResult = {
      name: 'agent_count_matches_notifications',
      passed: false,
      expected: agents.length,
      actual: notifications.length,
      durationMs: Date.now() - start,
      error: `Agent count ${agents.length} != Notification count ${notifications.length}`,
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
   * Format report as human-readable string
   */
  formatHumanReadableReport(report: TestReport): string {
    const lines: string[] = [];
    
    lines.push('='.repeat(60));
    lines.push('Test Report');
    lines.push('='.repeat(60));
    lines.push('');
    
    lines.push(`Scenario: ${report.scenario}`);
    lines.push(`Prompt: ${report.prompt}`);
    lines.push(`Started: ${new Date(report.startedAt).toISOString()}`);
    lines.push(`Completed: ${new Date(report.completedAt).toISOString()}`);
    lines.push(`Duration: ${report.durationMs}ms`);
    lines.push(`Status: ${report.passed ? '✅ PASSED' : '❌ FAILED'}`);
    lines.push('');
    
    lines.push('Assertions:');
    lines.push('-'.repeat(40));
    for (const assertion of report.assertions) {
      const status = assertion.passed ? '✅' : '❌';
      lines.push(`  ${status} ${assertion.name} (${assertion.durationMs}ms)`);
      if (assertion.error) {
        lines.push(`     Error: ${assertion.error}`);
      }
    }
    lines.push('');
    
    if (report.timeline.length > 0) {
      lines.push('Event Timeline:');
      lines.push('-'.repeat(40));
      for (const event of report.timeline) {
        const time = new Date(event.timestamp).toISOString();
        lines.push(`  ${time} | ${event.event}`);
        if (Object.keys(event.details).length > 0) {
          lines.push(`    Details: ${JSON.stringify(event.details)}`);
        }
      }
      lines.push('');
    }
    
    lines.push('Memory:');
    lines.push('-'.repeat(40));
    lines.push(`  Growth: ${report.resourceGrowthMB.toFixed(2)}MB`);
    if (report.memorySnapshot.length > 0) {
      const first = report.memorySnapshot[0];
      const last = report.memorySnapshot[report.memorySnapshot.length - 1];
      lines.push(`  Initial Heap: ${Math.round(first.heapUsed / 1024 / 1024)}MB`);
      lines.push(`  Final Heap: ${Math.round(last.heapUsed / 1024 / 1024)}MB`);
    }
    lines.push('');
    
    lines.push('Summary:');
    lines.push('-'.repeat(40));
    lines.push(`  ${report.summary}`);
    lines.push('');
    lines.push('='.repeat(60));
    
    return lines.join('\n');
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

// ─────────────────────────────────────────────────────────────
// Assertion Helpers
// ─────────────────────────────────────────────────────────────

export class AssertionHelpers {
  private readonly engine: AssertionEngine;

  constructor(engine: AssertionEngine) {
    this.engine = engine;
  }

  /**
   * Assert no tool call errors occurred
   */
  async assertNoToolCallErrors(): Promise<AssertionResult> {
    const start = Date.now();
    // Import dynamically to avoid circular dependency
    const { getCallRecords } = await import('../../../src/test-support/tool-call-hook.js');
    const records = getCallRecords();
    const errors = records.filter(r => r.error);
    
    const result: AssertionResult = {
      name: 'no_tool_call_errors',
      passed: errors.length === 0,
      actual: errors.length,
      expected: 0,
      durationMs: Date.now() - start,
      error: errors.length > 0 ? `${errors.length} tool call errors` : undefined,
    };
    return result;
  }

  /**
   * Assert that a sequence of events occurred in order
   */
  async assertEventSequence(
    eventNames: string[],
    timeoutMs: number
  ): Promise<AssertionResult> {
    const start = Date.now();
    const timeline = this.engine.getTimeline();
    
    for (const eventName of eventNames) {
      const found = timeline.find(e => e.event === eventName);
      if (!found) {
        // Wait for the event
        const result = await this.engine.waitForCondition(
          `event_sequence_${eventName}`,
          () => this.engine.getTimeline().some(e => e.event === eventName),
          timeoutMs
        );
        if (!result.passed) {
          return {
            name: 'event_sequence',
            passed: false,
            durationMs: Date.now() - start,
            error: `Event "${eventName}" not found in sequence`,
          };
        }
      }
    }

    return {
      name: 'event_sequence',
      passed: true,
      durationMs: Date.now() - start,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Test Scenario Runner
// ─────────────────────────────────────────────────────────────

export interface TestScenarioConfig {
  scenarioName: string;
  prompt: string;
  timeoutMs?: number;
  observers?: {
    registry?: RegistryObserver;
    mailbox?: MailboxObserver;
    ledger?: LedgerObserver;
    resource?: ResourceObserver;
  };
}

export class TestScenarioRunner {
  private readonly engine: AssertionEngine;
  private readonly helpers: AssertionHelpers;

  constructor() {
    this.engine = new AssertionEngine({});
    this.helpers = new AssertionHelpers(this.engine);
  }

  /**
   * Run a test scenario
   */
  async run(config: TestScenarioConfig): Promise<TestReport> {
    this.engine.start(config.scenarioName);
    
    try {
      // The actual test execution would be done by the caller
      // This method just provides the report generation
      
      const report = this.engine.generateReport(
        config.scenarioName,
        config.prompt,
        config.observers?.resource
      );
      
      return report;
    } finally {
      this.engine.reset();
    }
  }

  /**
   * Get the assertion engine for custom assertions
   */
  getEngine(): AssertionEngine {
    return this.engine;
  }

  /**
   * Get the assertion helpers
   */
  getHelpers(): AssertionHelpers {
    return this.helpers;
  }

  /**
   * Format report as human-readable string
   */
  formatReport(report: TestReport): string {
    return this.engine.formatHumanReadableReport(report);
  }
}
