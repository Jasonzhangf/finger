/**
 * Tool Call Hook Infrastructure
 * 
 * Provides hook registration and execution wrapping for tool calls,
 * enabling test scenarios like failure injection, delay simulation,
 * and parameter override.
 * 
 * Task: finger-280.1
 */

export {
  registerHook,
  unregisterHook,
  getHooks,
  executeWithHooks,
  getCallRecords,
  getCallTimeline,
  clearAllRecords,
  clearAllHooks,
  resetAll,
  getHookStats,
  getCallStats,
  type ToolCallHook,
  type BeforeCallResult,
  type ToolCallRecord,
} from '../../../src/test-support/tool-call-hook.js';

const log = logger.module('ToolCallHook');

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface BeforeCallResult {
  allowed: boolean;
  params?: Record<string, unknown>;
  reason?: string;
}

export interface ToolCallHook {
  beforeCall: (toolName: string, params: Record<string, unknown>) => BeforeCallResult;
  afterCall: (toolName: string, result: unknown) => unknown;
  onError: (toolName: string, error: Error) => void;
}

export interface ToolCallRecord {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: Error;
  timestamp: number;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────
// Global State
// ─────────────────────────────────────────────────────────────

/**
 * Global hook registry: toolName -> hooks[]
 */
const hookRegistry = new Map<string, ToolCallHook[]>();

/**
 * Global call records: chronological list of all tool calls
 */
let callRecords: ToolCallRecord[] = [];

// ─────────────────────────────────────────────────────────────
// Hook Registration
// ─────────────────────────────────────────────────────────────

/**
 * Register a hook for a specific tool
 * @param toolName - The tool name (e.g., 'agent.spawn', 'agent.send_message')
 * @param hook - The hook implementation
 * @returns Cleanup function to unregister the hook
 */
export function registerHook(toolName: string, hook: ToolCallHook): () => void {
  if (!hookRegistry.has(toolName)) {
    hookRegistry.set(toolName, []);
  }
  hookRegistry.get(toolName)!.push(hook);
  log.debug('Hook registered', { toolName, totalHooks: hookRegistry.get(toolName)!.length });
  
  return () => unregisterHook(toolName, hook);
}

/**
 * Unregister a specific hook
 * @param toolName - The tool name
 * @param hook - The hook to remove
 */
export function unregisterHook(toolName: string, hook: ToolCallHook): void {
  const hooks = hookRegistry.get(toolName);
  if (!hooks) return;
  
  const index = hooks.indexOf(hook);
  if (index !== -1) {
    hooks.splice(index, 1);
    log.debug('Hook unregistered', { toolName, remainingHooks: hooks.length });
    
    if (hooks.length === 0) {
      hookRegistry.delete(toolName);
    }
  }
}

/**
 * Get all registered hooks for a tool
 * @param toolName - The tool name
 * @returns Array of hooks (may be empty)
 */
export function getHooks(toolName: string): ToolCallHook[] {
  return hookRegistry.get(toolName) ?? [];
}

// ─────────────────────────────────────────────────────────────
// Execution Wrapper
// ─────────────────────────────────────────────────────────────

/**
 * Execute a tool function with all registered hooks
 * 
 * Flow:
 * 1. Run all beforeCall hooks - if any returns { allowed: false }, throw error
 * 2. Execute the actual function
 * 3. Run all afterCall hooks - can transform result
 * 4. If error, run all onError hooks
 * 5. Record the call to history
 * 
 * @param toolName - The tool name
 * @param fn - The actual tool function to execute
 * @param params - Parameters passed to the tool
 * @returns The result from the function (possibly transformed by afterCall hooks)
 */
export async function executeWithHooks<T>(
  toolName: string,
  fn: () => Promise<T>,
  params: Record<string, unknown>
): Promise<T> {
  const startTime = Date.now();
  const hooks = getHooks(toolName);
  
  let effectiveParams = { ...params };
  let record: ToolCallRecord = {
    toolName,
    params: effectiveParams,
    timestamp: startTime,
    durationMs: 0,
  };
  
  try {
    // Phase 1: beforeCall - all hooks must allow
    for (const hook of hooks) {
      const beforeResult = hook.beforeCall(toolName, effectiveParams);
      
      if (!beforeResult.allowed) {
        const error = new Error(`Tool call blocked: ${beforeResult.reason ?? 'no reason provided'}`);
        log.debug('Tool call blocked by hook', { toolName, reason: beforeResult.reason });
        throw error;
      }
      
      // Hooks can modify params
      if (beforeResult.params) {
        effectiveParams = beforeResult.params;
        record.params = effectiveParams;
      }
    }
    
    log.debug('Executing tool with hooks', { toolName, hookCount: hooks.length });
    
    // Phase 2: Execute actual function
    let result = await fn();
    
    // Phase 3: afterCall - hooks can transform result
    for (const hook of hooks) {
      result = hook.afterCall(toolName, result);
    }
    
    // Record success
    record.result = result;
    record.durationMs = Date.now() - startTime;
    callRecords.push(record);
    
    log.debug('Tool call completed', { toolName, durationMs: record.durationMs });
    
    return result;
    
  } catch (error) {
    // Phase 4: onError - notify all hooks
    const err = error instanceof Error ? error : new Error(String(error));
    
    for (const hook of hooks) {
      try {
        hook.onError(toolName, err);
      } catch (hookError) {
        log.error('Hook onError threw', hookError instanceof Error ? hookError : undefined, { toolName });
      }
    }
    
    // Record failure
    record.error = err;
    record.durationMs = Date.now() - startTime;
    callRecords.push(record);
    
    log.error('Tool call failed', err, { toolName, durationMs: record.durationMs });
    
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Call Records
// ─────────────────────────────────────────────────────────────

/**
 * Get all call records, optionally filtered by tool name
 * @param toolName - Optional filter by tool name
 * @returns Array of matching call records
 */
export function getCallRecords(toolName?: string): ToolCallRecord[] {
  if (toolName) {
    return callRecords.filter(r => r.toolName === toolName);
  }
  return [...callRecords];
}

/**
 * Get the timeline of all tool calls (alias for getCallRecords)
 * @returns Chronological list of all tool calls
 */
export function getCallTimeline(): ToolCallRecord[] {
  return [...callRecords];
}

/**
 * Clear all call records
 */
export function clearAllRecords(): void {
  callRecords = [];
  log.debug('All call records cleared');
}

/**
 * Clear all registered hooks
 */
export function clearAllHooks(): void {
  hookRegistry.clear();
  log.debug('All hooks cleared');
}

/**
 * Reset all state (both hooks and records)
 */
export function resetAll(): void {
  clearAllHooks();
  clearAllRecords();
}

// ─────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────

/**
 * Get statistics about hook registration
 */
export function getHookStats(): { totalTools: number; totalHooks: number; tools: Record<string, number> } {
  const tools: Record<string, number> = {};
  let totalHooks = 0;
  
  for (const [toolName, hooks] of hookRegistry) {
    tools[toolName] = hooks.length;
    totalHooks += hooks.length;
  }
  
  return {
    totalTools: hookRegistry.size,
    totalHooks,
    tools,
  };
}

/**
 * Get statistics about call records
 */
export function getCallStats(): {
  totalCalls: number;
  successCount: number;
  errorCount: number;
  byTool: Record<string, { count: number; successCount: number; errorCount: number; avgDurationMs: number }>;
} {
  const byTool: Record<string, { count: number; successCount: number; errorCount: number; totalDurationMs: number }> = {};
  
  for (const record of callRecords) {
    if (!byTool[record.toolName]) {
      byTool[record.toolName] = { count: 0, successCount: 0, errorCount: 0, totalDurationMs: 0 };
    }
    const stats = byTool[record.toolName];
    stats.count++;
    stats.totalDurationMs += record.durationMs;
    if (record.error) {
      stats.errorCount++;
    } else {
      stats.successCount++;
    }
  }
  
  const result: Record<string, { count: number; successCount: number; errorCount: number; avgDurationMs: number }> = {};
  for (const [toolName, stats] of Object.entries(byTool)) {
    result[toolName] = {
      count: stats.count,
      successCount: stats.successCount,
      errorCount: stats.errorCount,
      avgDurationMs: stats.totalDurationMs / stats.count,
    };
  }
  
  return {
    totalCalls: callRecords.length,
    successCount: callRecords.filter(r => !r.error).length,
    errorCount: callRecords.filter(r => r.error).length,
    byTool: result,
  };
}
