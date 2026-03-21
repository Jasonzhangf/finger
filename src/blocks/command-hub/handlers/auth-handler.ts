/**
 * Auth/Permission Command Handlers
 *
 * 处理用户授权命令：<##auth:grant@approvalId##> 或 <##auth:approvalId##>
 */

import { Command, CommandContext, CommandResult, CommandType, CommandHandler } from '../types.js';
import {
  permissionGrantTool,
  permissionDenyTool,
  permissionListTool,
} from '../../../tools/internal/permission-tools.js';
import { createToolExecutionContext } from '../../../tools/internal/types.js';
import { logger } from '../../../core/logger.js';

const log = logger.module('auth-handler');

/**
 * 处理授权命令 - 用户批准权限请求
 */
export class AuthGrantHandler implements CommandHandler {
  canHandle(cmd: Command): boolean {
    return cmd.type === CommandType.AUTH_GRANT;
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    const approvalId = cmd.params.approvalId;

    if (!approvalId) {
      return {
        success: false,
        output: '❌ 缺少授权 ID\n用法：<##auth:grant@approvalId##> 或 <##auth:approvalId##>',
        error: 'MISSING_APPROVAL_ID'
      };
    }

    try {
      log.info('Processing auth grant', { approvalId, channelId: ctx.channelId });

      const toolContext = createToolExecutionContext({ channelId: ctx.channelId, sessionId: ctx.sessionId });
      const result = await permissionGrantTool.execute(
        { approvalId, scope: 'session' },
        toolContext
      );

      if (result.granted) {
        return {
          success: true,
          output: `✅ 授权成功\n${result.message}`,
          data: { ...result }
        };
      }

      return {
        success: false,
        output: `❌ 授权失败：${result.message}`,
        error: 'GRANT_FAILED'
      };
    } catch (err) {
      log.error('Auth grant error', err instanceof Error ? err : undefined);
      return {
        success: false,
        output: `❌ 授权异常：${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}

/**
 * 处理拒绝命令 - 用户拒绝权限请求
 */
export class AuthDenyHandler implements CommandHandler {
  canHandle(cmd: Command): boolean {
    return cmd.type === CommandType.AUTH_DENY;
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    const approvalId = cmd.params.approvalId;

    if (!approvalId) {
      return {
        success: false,
        output: '❌ 缺少授权 ID\n用法：<##auth:deny@approvalId##>',
        error: 'MISSING_APPROVAL_ID'
      };
    }

    try {
      log.info('Processing auth deny', { approvalId, channelId: ctx.channelId });

      const toolContext = createToolExecutionContext({ channelId: ctx.channelId, sessionId: ctx.sessionId });
      const result = await permissionDenyTool.execute(
        { approvalId, reason: '用户拒绝' },
        toolContext
      );

      if (result.denied) {
        const detail = result.suggestion ? `\n${result.suggestion}` : '';
        return {
          success: true,
          output: `🚫 已拒绝授权\n${result.reason}${detail}`,
          data: { ...result }
        };
      }

      return {
        success: false,
        output: `❌ 拒绝失败：${result.reason}`,
        error: 'DENY_FAILED'
      };
    } catch (err) {
      log.error('Auth deny error', err instanceof Error ? err : undefined);
      return {
        success: false,
        output: `❌ 拒绝异常：${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}

/**
 * 处理状态查询命令 - 查看待授权的权限请求
 */
export class AuthStatusHandler implements CommandHandler {
  canHandle(cmd: Command): boolean {
    return cmd.type === CommandType.AUTH_STATUS;
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    try {
      log.info('Processing auth status', { channelId: ctx.channelId });

      const toolContext = createToolExecutionContext({ channelId: ctx.channelId, sessionId: ctx.sessionId });
      const result = await permissionListTool.execute({}, toolContext);

      const pending = result.pendingApprovals || [];
      const granted = result.grantedPermissions || [];
      const lines: string[] = [];
      lines.push(`当前权限模式：${result.currentMode}`);
      if (pending.length === 0) {
        lines.push('暂无待授权请求');
      } else {
        lines.push(`待授权请求 (${pending.length})：`);
        for (const req of pending) {
          lines.push(`- ${req.id} | ${req.toolName} | ${req.riskLevel} | ${req.reason}`);
          lines.push(`  授权：<##auth:${req.id}##>  拒绝：<##auth:deny@${req.id}##>`);
        }
      }
      if (granted.length > 0) {
        lines.push(`已授权 (${granted.length})：`);
        for (const item of granted) {
          lines.push(`- ${item.toolName} | ${item.scope}`);
        }
      }

      return {
        success: true,
        output: lines.join('\n'),
        data: { ...result }
      };
    } catch (err) {
      log.error('Auth status error', err instanceof Error ? err : undefined);
      return {
        success: false,
        output: `❌ 查询异常：${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}
