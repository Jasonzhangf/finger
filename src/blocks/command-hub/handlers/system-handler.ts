/**
 * System Command Handlers
 */

import * as path from 'path';
import { Command, CommandContext, CommandResult, CommandType, CommandHandler } from '../types.js';
import { loadProviderConfig, saveProviderConfig } from '../executor.js';

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
