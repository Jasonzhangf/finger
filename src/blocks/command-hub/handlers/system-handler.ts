/**
 * System Command Handlers
*/

import * as path from 'path';
import { Command, CommandContext, CommandResult, CommandType, CommandHandler } from '../types.js';
import { loadProviderConfig, saveProviderConfig } from '../executor.js';
import { clockTool } from '../../../tools/internal/codex-clock-tool.js';

export class SystemRestartHandler implements CommandHandler {
  canHandle(cmd: Command): boolean {
    return cmd.type === CommandType.SYSTEM_RESTART;
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    try {
      const daemon = (globalThis as any).__daemonInstance;
      if (daemon && typeof daemon.restart === 'function') {
        await daemon.restart();
        return {
          success: true,
          output: '系统重启指令已接收，正在安全重启 daemon...'
        };
      }
      return {
        success: false,
        output: '⚠️ Daemon 实例不可用，请手动重启服务'
      };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}

export class SystemSwitchHandler implements CommandHandler {
  canHandle(cmd: Command): boolean {
    return cmd.type === CommandType.SYSTEM;
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    if (ctx.updateContext && ctx.channelId) {
      ctx.updateContext(ctx.channelId, 'system', 'finger-system-agent');
    }

    return {
      success: true,
      output: '已切换到 System Agent（上下文持久）'
    };
  }
}
import { createToolExecutionContext } from '../../../tools/internal/types.js';

export class ClockCreateHandler implements CommandHandler {
  canHandle(cmd: Command): boolean {
    return cmd.type === CommandType.CLOCK_CREATE;
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    try {
      const schedule = cmd.params.schedule || {};
      const inject = cmd.params.inject;

      const clockInput = {
        action: 'create',
        payload: {
          message: cmd.params.message || 'Clock task',
          schedule_type: (schedule as any).type || 'delay',
          delay_seconds: (schedule as any).delaySeconds,
          at: (schedule as any).at,
          cron: (schedule as any).cron,
          timezone: (schedule as any).timezone,
          repeat: (schedule as any).repeat ?? false,
          max_runs: (schedule as any).maxRuns,
          ...(inject ? { inject } : {}),
        },
      };

      const ctx = createToolExecutionContext();
      const result = await clockTool.execute(clockInput, ctx);
      return {
        success: result.ok,
        output: result.content,
        data: result.data,
      };
    } catch (err) {
      return {
        success: false,
        output: '创建定时任务失败',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export class ProviderListHandler implements CommandHandler {
  canHandle(cmd: Command): boolean {
    return cmd.type === CommandType.PROVIDER_LIST;
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    const configPath = ctx.configPath || path.join(process.env.HOME || '', '.finger/config/config.json');
    const { providers, current } = loadProviderConfig(configPath);
    
    const lines = ['可用 AI Provider：\n'];
    
    Object.entries(providers).forEach(([id, cfg]: [string, any]) => {
      const isCurrent = id === current;
      const marker = isCurrent ? ' [当前]' : '';
      const baseUrl = cfg?.base_url || 'unknown';
      const model = cfg?.model || 'unknown';
      lines.push(`  - ${id}${marker}: ${model} @ ${baseUrl}`);
    });
    
    lines.push('\n使用 <##@system:provider:switch@id##> 切换 provider');
    
    return {
      success: true,
      output: lines.join('\n')
    };
  }
}

export class ProviderSwitchHandler implements CommandHandler {
  canHandle(cmd: Command): boolean {
    return cmd.type === CommandType.PROVIDER_SWITCH;
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    const providerId = cmd.params.providerId;
    
    if (!providerId) {
      return {
        success: false,
        output: '',
        error: 'Provider ID is required'
      };
    }
    
    const configPath = ctx.configPath || path.join(process.env.HOME || '', '.finger/config/config.json');
    const { providers } = loadProviderConfig(configPath);
    
    if (!providers[providerId]) {
      return {
        success: false,
        output: `❌ Provider 不存在：${providerId}\n\n使用 <##@system:provider:list##> 查看可用 providers`
      };
    }
    
    const success = saveProviderConfig(configPath, providerId);
    if (!success) {
      return {
        success: false,
        output: '❌ 切换失败：无法保存配置'
      };
    }
    
    const cfg = providers[providerId];
    return {
      success: true,
      output: `✓ 已切换到 provider：${providerId}\n  Model: ${cfg?.model || 'unknown'}\n  URL: ${cfg?.base_url || 'unknown'}\n\n重启 agent 后生效`
    };
  }
}
