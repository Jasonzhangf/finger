import type { MockAgentRole, MockOutcome, MockRuntimeDeps } from './types.js';
import type { ChatCodexRunnerController } from './adaptive-runner.js';
import type {
  KernelInputItem,
  ChatCodexRunContext,
  ChatCodexRunResult,
  ChatCodexRunnerSessionState,
  ChatCodexRunnerInterruptResult,
} from '../../../agents/finger-general/finger-general-module.js';
import { isObjectRecord } from '../../common/object.js';
import { firstNonEmptyString } from '../../common/strings.js';
import { parseMockOutcome, pickMessageContext } from './utils.js';

export class MockChatCodexRunner implements ChatCodexRunnerController {
  private readonly sessions = new Map<string, ChatCodexRunnerSessionState>();
  private readonly deps: MockRuntimeDeps;
  private readonly mockRolePolicy: Record<MockAgentRole, MockOutcome>;

  constructor(deps: MockRuntimeDeps, mockRolePolicy: Record<MockAgentRole, MockOutcome>) {
    this.deps = deps;
    this.mockRolePolicy = mockRolePolicy;
  }

  async runTurn(text: string, _items?: KernelInputItem[], context?: ChatCodexRunContext): Promise<ChatCodexRunResult> {
    const sessionId = typeof context?.sessionId === 'string' && context.sessionId.trim().length > 0
      ? context.sessionId.trim()
      : 'mock-session';
    const metadata = isObjectRecord(context?.metadata) ? context.metadata : {};
    const roleProfile = firstNonEmptyString(
      metadata.roleProfile,
      metadata.role_profile,
      metadata.contextLedgerRole,
      metadata.context_ledger_role,
      metadata.role,
    ) ?? 'orchestrator';
    const workflowId = firstNonEmptyString(metadata.workflowId, metadata.workflow_id) ?? `wf-mock-${Date.now()}`;
    const content = text.trim().length > 0 ? text.trim() : '[empty input]';
    const providerId = 'mock';

    this.sessions.set(sessionId, { sessionKey: `${providerId}:${sessionId}`, sessionId, providerId, hasActiveTurn: false });

    const normalizedRole = roleProfile.trim().toLowerCase();
    if (!normalizedRole.includes('orchestr') && normalizedRole !== 'general') {
      return this.runRoleTurn(normalizedRole, { sessionId, workflowId, content, historyCount: Array.isArray(context?.history) ? context.history.length : 0 });
    }

    const shouldDispatchToSearcher = this.shouldTriggerSearchDispatch(content);
    if (shouldDispatchToSearcher) {
      const dispatchResult = await this.dispatchToAgent('searcher', content, sessionId, workflowId);
      return this.buildDispatchResult(dispatchResult, content);
    }

    return this.buildOrchestratorResult(content);
  }

  private shouldTriggerSearchDispatch(content: string): boolean {
    const triggers = ['search', 'find', 'lookup', 'query', '检索', '查找', '搜索'];
    return triggers.some(t => content.toLowerCase().includes(t));
  }

  private async dispatchToAgent(role: MockAgentRole, taskContent: string, sessionId: string, workflowId: string): Promise<{ ok: boolean; dispatchId?: string; status?: string; result?: unknown; error?: string }> {
    const targetId = this.resolveAgentId(role);
    try {
      const result = await this.deps.dispatchTask({
        sourceAgentId: this.deps.primaryOrchestratorAgentId,
        targetAgentId: targetId,
        task: { description: taskContent },
        sessionId,
        workflowId,
        blocking: true,
      });
      return { ok: result.ok, dispatchId: result.dispatchId, status: result.status, result: result.result, error: result.error };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private resolveAgentId(role: MockAgentRole): string {
    switch (role) {
      case 'executor': return this.deps.agentIds.executor;
      case 'reviewer': return this.deps.agentIds.reviewer;
      case 'searcher': return this.deps.agentIds.researcher;
    }
  }

  private buildDispatchResult(dispatchResult: { ok: boolean; dispatchId?: string; status?: string; result?: unknown; error?: string }, content: string): ChatCodexRunResult {
    return {
      reply: dispatchResult.ok ? `[Mock Orchestrator] Dispatch succeeded: ${dispatchResult.dispatchId}` : `[Mock Orchestrator] Dispatch failed: ${dispatchResult.error}`,
      events: [],
      usedBinaryPath: 'mock',
      kernelMetadata: { dispatchId: dispatchResult.dispatchId, dispatchStatus: dispatchResult.ok ? 'completed' : 'failed', originalContent: content },
    };
  }

  private buildOrchestratorResult(content: string): ChatCodexRunResult {
    return { reply: `[Mock Orchestrator] Processed: ${content}`, events: [], usedBinaryPath: 'mock' };
  }

  private async runRoleTurn(normalizedRole: string, ctx: { sessionId: string; workflowId: string; content: string; historyCount: number }): Promise<ChatCodexRunResult> {
    const role = this.inferRoleFromProfile(normalizedRole);
    const outcome = this.mockRolePolicy[role] ?? 'success';

    if (outcome === 'success') {
      return { reply: `[Mock ${role}] Completed task: ${ctx.content}`, events: [], usedBinaryPath: 'mock', kernelMetadata: { outcome, role } };
    } else {
      return { reply: `[Mock ${role}] Failed task: ${ctx.content}`, events: [], usedBinaryPath: 'mock', kernelMetadata: { outcome, role, error: `Mock ${role} failed as per policy` } };
    }
  }

  private inferRoleFromProfile(profile: string): MockAgentRole {
    const p = profile.toLowerCase();
    if (p.includes('exec')) return 'executor';
    if (p.includes('review')) return 'reviewer';
    if (p.includes('search') || p.includes('research')) return 'searcher';
    return 'executor';
  }

  listSessionStates(sessionId?: string, providerId?: string): ChatCodexRunnerSessionState[] {
    const all = Array.from(this.sessions.values());
    let filtered = all;
    if (sessionId) filtered = filtered.filter(s => s.sessionId === sessionId);
    if (providerId) filtered = filtered.filter(s => s.providerId === providerId);
    return filtered;
  }

  interruptSession(sessionId: string, providerId?: string): ChatCodexRunnerInterruptResult[] {
    const results: ChatCodexRunnerInterruptResult[] = [];
    for (const state of this.sessions.values()) {
      if (state.sessionId === sessionId && (!providerId || state.providerId === providerId)) {
        results.push({ sessionKey: state.sessionKey, sessionId: state.sessionId, providerId: state.providerId, hadActiveTurn: state.hasActiveTurn, interrupted: false });
      }
    }
    return results;
  }
}
