/**
 * Permission Management Tools
 *
 * 提供权限检查、授权、拒绝、列表四个工具，让模型可以主动管理权限。
 * 参考 Codex 的 request_permissions / AskForApproval / RejectConfig 设计。
 */

import { InternalTool, ToolExecutionContext } from './types.js';
import { logger } from '../../core/logger.js';

const log = logger.module('permission-tools');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PermissionMode = 'minimal' | 'default' | 'full';

export type PermissionGrantScope = 'turn' | 'session';

export interface RejectConfig {
  sandboxEscalation: boolean;   // 拒绝沙箱升级审批
  policyRules: boolean;         // 拒绝策略规则审批
  skillApproval: boolean;       // 拒绝 skill 执行审批
  permissionRequest: boolean;   // 拒绝权限升级请求
  mcpElicitation: boolean;      // 拒绝 MCP 征求
}

export interface PermissionApprovalRequest {
  id: string;
  toolName: string;
  command?: string;
  reason: string;
  riskLevel: 'low' | 'medium' | 'high';
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'granted' | 'denied' | 'expired';
  grantedScope?: PermissionGrantScope;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  requiresApproval: boolean;
  approvalId?: string;
  riskLevel?: 'low' | 'medium' | 'high';
  suggestion?: string;
}

export interface PermissionGrantResult {
  granted: boolean;
  approvalId: string;
  scope: PermissionGrantScope;
  message: string;
}

export interface PermissionDenyResult {
  denied: boolean;
  approvalId: string;
  reason: string;
  suggestion: string;
}

export interface PermissionListResult {
  pendingApprovals: PermissionApprovalRequest[];
  grantedPermissions: Array<{
    toolName: string;
    scope: PermissionGrantScope;
    grantedAt: number;
  }>;
  currentMode: PermissionMode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Permission State Manager
// ─────────────────────────────────────────────────────────────────────────────

class PermissionStateManager {
  // Per-scope state: key = channelId || sessionId || 'global'
  private scopedApprovals = new Map<string, Map<string, PermissionApprovalRequest>>();
  private scopedGrants = new Map<string, Map<string, { scope: PermissionGrantScope; grantedAt: number }>>();
  private currentMode: PermissionMode = 'default';
  private rejectConfig: RejectConfig = {
    sandboxEscalation: false,
    policyRules: false,
    skillApproval: false,
    permissionRequest: false,
    mcpElicitation: false,
  };

  private generateId(): string {
    return `perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Resolve scope key: channelId > sessionId > 'global'
   */
  getScopeKey(channelId?: string, sessionId?: string): string {
    if (channelId) return `ch:${channelId}`;
    if (sessionId) return `sess:${sessionId}`;
    return 'global';
  }

  private getApprovals(scopeKey: string): Map<string, PermissionApprovalRequest> {
    if (!this.scopedApprovals.has(scopeKey)) {
      this.scopedApprovals.set(scopeKey, new Map());
    }
    return this.scopedApprovals.get(scopeKey)!;
  }

  private getGrants(scopeKey: string): Map<string, { scope: PermissionGrantScope; grantedAt: number }> {
    if (!this.scopedGrants.has(scopeKey)) {
      this.scopedGrants.set(scopeKey, new Map());
    }
    return this.scopedGrants.get(scopeKey)!;
  }

  setMode(mode: PermissionMode): void {
    this.currentMode = mode;
    log.info('[Permission] Mode set', { mode });
  }

  getMode(): PermissionMode {
    return this.currentMode;
  }

  setRejectConfig(config: Partial<RejectConfig>): void {
    this.rejectConfig = { ...this.rejectConfig, ...config };
    log.info('[Permission] RejectConfig updated', { config: this.rejectConfig });
  }

  getRejectConfig(): RejectConfig {
    return { ...this.rejectConfig };
  }

  createApprovalRequest(
    toolName: string,
    reason: string,
    riskLevel: 'low' | 'medium' | 'high',
    command?: string,
    ttlMs: number = 60000,
    scopeKey: string = 'global'
  ): PermissionApprovalRequest {
    const id = this.generateId();
    const now = Date.now();
    const request: PermissionApprovalRequest = {
      id,
      toolName,
      command,
      reason,
      riskLevel,
      createdAt: now,
      expiresAt: now + ttlMs,
      status: 'pending',
    };
    this.getApprovals(scopeKey).set(id, request);
    log.info('[Permission] Approval request created', { id, toolName, riskLevel, scopeKey });
    return request;
  }

  getApprovalRequest(id: string, scopeKey: string = 'global'): PermissionApprovalRequest | undefined {
    const request = this.getApprovals(scopeKey).get(id);
    if (request && Date.now() > request.expiresAt) {
      request.status = 'expired';
      this.getApprovals(scopeKey).delete(id);
      return undefined;
    }
    return request;
  }

  grantApproval(id: string, scope: PermissionGrantScope, scopeKey: string = 'global'): PermissionGrantResult | null {
    const request = this.getApprovalRequest(id, scopeKey);
    if (!request) {
      log.warn('[Permission] Approval request not found or expired', { id, scopeKey });
      return null;
    }

    request.status = 'granted';
    request.grantedScope = scope;
    this.getGrants(scopeKey).set(request.toolName, { scope, grantedAt: Date.now() });
    this.getApprovals(scopeKey).delete(id);

    log.info('[Permission] Approval granted', { id, toolName: request.toolName, scope, scopeKey });
    return {
      granted: true,
      approvalId: id,
      scope,
      message: `已授权执行 ${request.toolName}`,
    };
  }

  denyApproval(id: string, reason: string, scopeKey: string = 'global'): PermissionDenyResult | null {
    const request = this.getApprovalRequest(id, scopeKey);
    if (!request) {
      log.warn('[Permission] Approval request not found or expired', { id, scopeKey });
      return null;
    }

    request.status = 'denied';
    this.getApprovals(scopeKey).delete(id);

    log.info('[Permission] Approval denied', { id, toolName: request.toolName, reason, scopeKey });
    return {
      denied: true,
      approvalId: id,
      reason,
      suggestion: `用户拒绝了 ${request.toolName} 的执行请求。您可以选择：1) 告知用户拒绝原因；2) 尝试其他方案；3) 请求用户重新授权。`,
    };
  }

  isGranted(toolName: string, scopeKey: string = 'global'): boolean {
    return this.getGrants(scopeKey).has(toolName);
  }

  listPending(scopeKey: string = 'global'): PermissionApprovalRequest[] {
    const now = Date.now();
    const pending: PermissionApprovalRequest[] = [];
    for (const request of this.getApprovals(scopeKey).values()) {
      if (now <= request.expiresAt) {
        pending.push(request);
      } else {
        request.status = 'expired';
        this.getApprovals(scopeKey).delete(request.id);
      }
    }
    return pending;
  }

  listGranted(scopeKey: string = 'global'): PermissionListResult['grantedPermissions'] {
    return Array.from(this.getGrants(scopeKey).entries()).map(([toolName, data]) => ({
      toolName,
      ...data,
    }));
  }

  clearExpired(scopeKey: string = 'global'): number {
    const now = Date.now();
    let cleared = 0;
    for (const [id, request] of this.getApprovals(scopeKey).entries()) {
      if (now > request.expiresAt) {
        request.status = 'expired';
        this.getApprovals(scopeKey).delete(id);
        cleared++;
      }
    }
    if (cleared > 0) {
      log.info('[Permission] Cleared expired requests', { count: cleared, scopeKey });
    }
    return cleared;
  }

  /**
   * Reset state for tests.
   */
  reset(): void {
    this.scopedApprovals.clear();
    this.scopedGrants.clear();
    this.currentMode = 'default';
    this.rejectConfig = {
      sandboxEscalation: false,
      policyRules: false,
      skillApproval: false,
      permissionRequest: false,
      mcpElicitation: false,
    };
  }
}

// Singleton instance
export const permissionState = new PermissionStateManager();

// ─────────────────────────────────────────────────────────────────────────────
// Tool: permission.check
// ─────────────────────────────────────────────────────────────────────────────

export const permissionCheckTool: InternalTool<unknown, PermissionCheckResult> = {
  name: 'permission.check',
  description: `检查工具或命令是否需要用户授权。

在执行高危命令（如 shell.exec、file.delete）前调用此工具，判断是否需要用户确认。
如果返回 requiresApproval=true，需要等待用户授权后才能执行。

参数:
- toolName: 要检查的工具名称（如 "shell.exec"）
- command: 可选的具体命令（用于判断是否高危）
- reason: 执行原因（会显示给用户）`,
  inputSchema: {
    type: 'object',
    properties: {
      toolName: { type: 'string', description: '要检查的工具名称' },
      command: { type: 'string', description: '可选的具体命令' },
      reason: { type: 'string', description: '执行原因' },
    },
    required: ['toolName'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<PermissionCheckResult> => {
    const input = rawInput as { toolName: string; command?: string; reason?: string };
    const { toolName, command, reason } = input;

    log.info('[permission.check] Checking', { toolName, command });

    // 检查是否已授权
    const scopeKey = permissionState.getScopeKey(context.channelId, context.sessionId);

    if (permissionState.isGranted(toolName, scopeKey)) {
      return {
        allowed: true,
        requiresApproval: false,
        reason: '已授权',
      };
    }

    // 检查当前模式
    const mode = permissionState.getMode();
    if (mode === 'full') {
      return {
        allowed: true,
        requiresApproval: false,
        reason: 'full 模式：所有命令默认可执行',
      };
    }

    if (mode === 'minimal') {
      // minimal 模式：每次都需要授权
      const request = permissionState.createApprovalRequest(
        toolName,
        reason || `执行工具: ${toolName}`,
        'medium',
        command,
        undefined,
        scopeKey
      );
      return {
        allowed: false,
        requiresApproval: true,
        approvalId: request.id,
        riskLevel: 'medium',
        reason: 'minimal 模式：需要用户授权',
        suggestion: `请让用户回复授权码: <##auth:${request.id}##>`,
      };
    }

    // default 模式：检查是否高危命令
    const highRiskPatterns = [
      /^rm\s+-rf/,
      /^rm\s+.*-rf/,
      /git\s+reset\s+--hard/,
      /git\s+checkout/,
      /file\.delete/,
    ];

    const isHighRisk = command
      ? highRiskPatterns.some(p => p.test(command))
      : ['shell.exec', 'file.delete'].includes(toolName);

    if (isHighRisk) {
      const request = permissionState.createApprovalRequest(
        toolName,
        reason || `高危命令需要授权: ${command || toolName}`,
        'high',
        command,
        undefined,
        scopeKey
      );
      return {
        allowed: false,
        requiresApproval: true,
        approvalId: request.id,
        riskLevel: 'high',
        reason: `高危命令需要用户授权: ${command || toolName}`,
        suggestion: `请让用户回复授权码: <##auth:${request.id}##>`,
      };
    }

    // 非高危命令，直接通过
    return {
      allowed: true,
      requiresApproval: false,
      reason: '非高危命令，默认允许',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: permission.grant
// ─────────────────────────────────────────────────────────────────────────────

export const permissionGrantTool: InternalTool<unknown, PermissionGrantResult> = {
  name: 'permission.grant',
  description: `授权执行某个工具或命令。

用户通过 QQBot 回复 <##auth:xxx##> 或 WebUI 点击授权按钮后，调用此工具完成授权。

参数:
- approvalId: 审批请求ID
- scope: 授权范围，"turn" (本轮有效) 或 "session" (会话内有效)`,
  inputSchema: {
    type: 'object',
    properties: {
      approvalId: { type: 'string', description: '审批请求ID' },
      scope: { type: 'string', enum: ['turn', 'session'], description: '授权范围' },
    },
    required: ['approvalId'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<PermissionGrantResult> => {
    const input = rawInput as { approvalId: string; scope?: PermissionGrantScope };
    const { approvalId, scope = 'turn' } = input;

    log.info('[permission.grant] Granting', { approvalId, scope });

    const scopeKey = permissionState.getScopeKey(context.channelId, context.sessionId);
    const result = permissionState.grantApproval(approvalId, scope, scopeKey);
    if (!result) {
      return {
        granted: false,
        approvalId,
        scope,
        message: '授权请求不存在或已过期',
      };
    }

    return result;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: permission.deny
// ─────────────────────────────────────────────────────────────────────────────

export const permissionDenyTool: InternalTool<unknown, PermissionDenyResult> = {
  name: 'permission.deny',
  description: `拒绝执行某个工具或命令。

用户拒绝授权后调用此工具，模型会收到拒绝结果和建议。

参数:
- approvalId: 审批请求ID
- reason: 拒绝原因`,
  inputSchema: {
    type: 'object',
    properties: {
      approvalId: { type: 'string', description: '审批请求ID' },
      reason: { type: 'string', description: '拒绝原因' },
    },
    required: ['approvalId'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<PermissionDenyResult> => {
    const input = rawInput as { approvalId: string; reason?: string };
    const { approvalId, reason = '用户拒绝授权' } = input;

    log.info('[permission.deny] Denying', { approvalId, reason });

    const scopeKey = permissionState.getScopeKey(context.channelId, context.sessionId);
    const result = permissionState.denyApproval(approvalId, reason, scopeKey);
    if (!result) {
      return {
        denied: false,
        approvalId,
        reason: '授权请求不存在或已过期',
        suggestion: '授权请求已过期，可以重新发起授权请求',
      };
    }

    return result;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool: permission.list
// ─────────────────────────────────────────────────────────────────────────────

export const permissionListTool: InternalTool<unknown, PermissionListResult> = {
  name: 'permission.list',
  description: `查看当前权限状态。

返回待审批列表、已授权列表和当前权限模式。`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  execute: async (_rawInput: unknown, context: ToolExecutionContext): Promise<PermissionListResult> => {
    log.info('[permission.list] Listing permissions');

    // 清理过期请求
    const scopeKey = permissionState.getScopeKey(context.channelId, context.sessionId);
    permissionState.clearExpired(scopeKey);

    return {
      pendingApprovals: permissionState.listPending(scopeKey),
      grantedPermissions: permissionState.listGranted(scopeKey),
      currentMode: permissionState.getMode(),
    };
  },
};

// Export all tools
export const permissionTools = [
  permissionCheckTool,
  permissionGrantTool,
  permissionDenyTool,
  permissionListTool,
];
