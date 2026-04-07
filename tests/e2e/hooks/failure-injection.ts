/**
 * Failure Injection Hook for Testing
 * 
 * Provides hooks that can inject failures, delays, timeouts,
 * and parameter overrides for testing tool call resilience.
 * 
 * Task: finger-280.10
 */

import {
  registerHook,
  type ToolCallHook,
  type BeforeCallResult,
} from '../../src/test-support/tool-call-hook.js';

/**
 * FailureInjector - Hook factory for injecting test conditions
 * 
 * Each injection method returns a cleanup function to remove the injection.
 */
export class FailureInjector {
  private cleanupFns: Array<() => void> = [];

  /**
   * Inject a delay before tool execution
   * @param toolName - Tool to delay
   * @param delayMs - Delay in milliseconds
   * @returns Cleanup function to remove the injection
   */
  injectDelay(toolName: string, delayMs: number): () => void {
    const hook: ToolCallHook = {
      beforeCall: async (_name: string, params: Record<string, unknown>): Promise<BeforeCallResult> => {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return { allowed: true, params };
      },
      afterCall: (_name: string, result: unknown) => result,
      onError: () => {},
    };

    const cleanup = registerHook(toolName, hook);
    this.cleanupFns.push(cleanup);
    return cleanup;
  }

  /**
   * Inject random failures
   * @param toolName - Tool to fail
   * @param failureRate - Probability of failure (0.0 - 1.0)
   * @returns Cleanup function to remove the injection
   */
  injectFailure(toolName: string, failureRate: number): () => void {
    const hook: ToolCallHook = {
      beforeCall: (_name: string, params: Record<string, unknown>): BeforeCallResult => {
        if (Math.random() < failureRate) {
          return { allowed: false, reason: `Injected failure (${(failureRate * 100).toFixed(0)}% rate)` };
        }
        return { allowed: true, params };
      },
      afterCall: (_name: string, result: unknown) => result,
      onError: () => {},
    };

    const cleanup = registerHook(toolName, hook);
    this.cleanupFns.push(cleanup);
    return cleanup;
  }

  /**
   * Inject timeout by delaying past a threshold
   * @param toolName - Tool to timeout
   * @param timeoutMs - Timeout duration in milliseconds
   * @returns Cleanup function to remove the injection
   */
  injectTimeout(toolName: string, timeoutMs: number): () => void {
    const hook: ToolCallHook = {
      beforeCall: async (_name: string, params: Record<string, unknown>): Promise<BeforeCallResult> => {
        // Force a delay that exceeds typical timeout
        await new Promise(resolve => setTimeout(resolve, timeoutMs));
        return { allowed: true, params };
      },
      afterCall: (_name: string, result: unknown) => result,
      onError: () => {},
    };

    const cleanup = registerHook(toolName, hook);
    this.cleanupFns.push(cleanup);
    return cleanup;
  }

  /**
   * Inject parameter override
   * @param toolName - Tool to override
   * @param paramKey - Parameter key to override
   * @param newValue - New value for the parameter
   * @returns Cleanup function to remove the injection
   */
  injectParamOverride(toolName: string, paramKey: string, newValue: unknown): () => void {
    const hook: ToolCallHook = {
      beforeCall: (_name: string, params: Record<string, unknown>): BeforeCallResult => {
        const modifiedParams = { ...params, [paramKey]: newValue };
        return { allowed: true, params: modifiedParams };
      },
      afterCall: (_name: string, result: unknown) => result,
      onError: () => {},
    };

    const cleanup = registerHook(toolName, hook);
    this.cleanupFns.push(cleanup);
    return cleanup;
  }

  /**
   * Clear all injections created by this injector
   */
  clearAll(): void {
    for (const cleanup of this.cleanupFns) {
      cleanup();
    }
    this.cleanupFns = [];
  }
}

/**
 * Create a failure injector instance
 */
export function createFailureInjector(): FailureInjector {
  return new FailureInjector();
}

/**
 * Pre-built hooks for common scenarios
 */
export const FailureHooks = {
  /**
   * Hook that blocks all calls with a specific reason
   */
  blockAll: (reason: string): ToolCallHook => ({
    beforeCall: () => ({ allowed: false, reason }),
    afterCall: (_, result) => result,
    onError: () => {},
  }),

  /**
   * Hook that adds a delay to all calls
   */
  delayAll: (delayMs: number): ToolCallHook => ({
    beforeCall: async (_, params) => {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return { allowed: true, params };
    },
    afterCall: (_, result) => result,
    onError: () => {},
  }),

  /**
   * Hook that modifies a specific parameter
   */
  overrideParam: (paramKey: string, newValue: unknown): ToolCallHook => ({
    beforeCall: (_, params) => {
      const modifiedParams = { ...params, [paramKey]: newValue };
      return { allowed: true, params: modifiedParams };
    },
    afterCall: (_, result) => result,
    onError: () => {},
  }),

  /**
   * Hook that tracks all errors
   */
  errorTracker: (errors: Array<{ toolName: string; error: Error }>): ToolCallHook => ({
    beforeCall: (_, params) => ({ allowed: true, params }),
    afterCall: (_, result) => result,
    onError: (toolName, error) => {
      errors.push({ toolName, error });
    },
  }),

  /**
   * Hook that transforms results
   */
  transformResult: <T>(transformer: (result: unknown) => T): ToolCallHook => ({
    beforeCall: (_, params) => ({ allowed: true, params }),
    afterCall: (_, result) => transformer(result),
    onError: () => {},
  }),
};
