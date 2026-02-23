/**
 * Test Runner - 自动化测试运行器
 * 编排测试流程，管理测试环境
 */

import type { 
  TestRunner, 
  TestScenario, 
  TestResult, 
  StepResult,
  TestStep,
  TestExpectation 
} from './index.js';
import { createTestAPI, type TestAPI } from './test-api.js';

class TestRunnerImpl implements TestRunner {
  private api: TestAPI;

  constructor() {
    this.api = createTestAPI();
  }

  async runTestScenario(scenario: TestScenario): Promise<TestResult> {
    const startTime = Date.now();
    const steps: StepResult[] = [];
    let passed = true;
    let error: string | undefined;

    try {
      // 设置环境
      await this.setupTestEnvironment();

      // 执行测试步骤
      for (let i = 0; i < scenario.steps.length; i++) {
        const step = scenario.steps[i];
        const stepStart = Date.now();
        
        try {
          await this.executeStep(step);
          steps.push({
            step: i + 1,
            action: step.action,
            passed: true,
            durationMs: Date.now() - stepStart,
          });
        } catch (err) {
          passed = false;
          error = err instanceof Error ? err.message : String(err);
          steps.push({
            step: i + 1,
            action: step.action,
            passed: false,
            durationMs: Date.now() - stepStart,
            error,
          });
          break;
        }

        if (step.delayMs) {
          await this.delay(step.delayMs);
        }
      }

      // 验证期望
      if (passed) {
        for (const expectation of scenario.expectations) {
          const result = await this.verifyExpectation(expectation);
          if (!result.passed) {
            passed = false;
            error = `Expectation failed: ${result.message}`;
            break;
          }
        }
      }
    } catch (err) {
      passed = false;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      await this.cleanupTestEnvironment();
    }

    return {
      passed,
      scenario: scenario.name,
      steps,
      durationMs: Date.now() - startTime,
      error,
    };
  }

  async setupTestEnvironment(): Promise<void> {
    await this.api.startServer();
    await this.api.resetState();
  }

  async cleanupTestEnvironment(): Promise<void> {
    await this.api.stopServer();
  }

  private async executeStep(step: TestStep): Promise<void> {
    switch (step.action) {
      case 'sendInput':
        await this.api.sendUserInput(step.params?.text as string);
        break;
      case 'waitForResponse':
        const events = await this.api.waitForAgentResponse(
          (step.params?.timeout as number) || 30000
        );
        if (events.length === 0) {
          throw new Error('No agent response received');
        }
        break;
      case 'pause':
        const pauseRes = await fetch('/api/v1/workflows/pause', { method: 'POST' });
        if (!pauseRes.ok) throw new Error('Failed to pause workflow');
        break;
      case 'resume':
        const resumeRes = await fetch('/api/v1/workflows/resume', { method: 'POST' });
        if (!resumeRes.ok) throw new Error('Failed to resume workflow');
        break;
      case 'stop':
        const stopRes = await fetch('/api/v1/workflows/stop', { method: 'POST' });
        if (!stopRes.ok) throw new Error('Failed to stop workflow');
        break;
      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
  }

  private async verifyExpectation(expectation: TestExpectation): Promise<{ passed: boolean; message: string }> {
    const timeout = expectation.timeoutMs || 10000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const state = await this.api.getExecutionState();
        
        switch (expectation.type) {
          case 'workflowStatus':
            if (state.status === expectation.expectedValue) {
              return { passed: true, message: '' };
            }
            break;
          case 'agentStatus':
            const agent = state.agents.find(a => a.id === expectation.selector);
            if (agent && agent.status === expectation.expectedValue) {
              return { passed: true, message: '' };
            }
            break;
          default:
            return { passed: false, message: `Unknown expectation type: ${expectation.type}` };
        }
      } catch {
        // 继续轮询
      }
      
      await this.delay(100);
    }

    return { 
      passed: false, 
      message: `Timeout waiting for ${expectation.type} to be ${expectation.expectedValue}` 
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export function createTestRunner(): TestRunner {
  return new TestRunnerImpl();
}

// 导出单例
export const testRunner = createTestRunner();
