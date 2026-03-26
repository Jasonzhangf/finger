/**
 * Agent Command Handlers
 */

import { Command, CommandContext, CommandResult, CommandType, CommandHandler } from '../types.js';
import { listProjectAgentAliases, resolveProjectAgentAlias } from '../../../orchestration/project-agent-alias.js';

export class AgentSwitchHandler implements CommandHandler {
  canHandle(cmd: Command): boolean {
    return cmd.type === CommandType.AGENT || cmd.type === CommandType.AGENT_LIST || cmd.type === CommandType.AGENT_NEW || cmd.type === CommandType.AGENT_SWITCH || cmd.type === CommandType.AGENT_DELETE;
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    if (cmd.type === CommandType.AGENT_LIST) {
      const aliases = await listProjectAgentAliases({ monitoredOnly: true });
      if (aliases.length === 0) {
        return {
          success: true,
          output: '当前没有可切换的监控项目（monitored=true）。',
        };
      }
      const lines = aliases.map((entry, index) =>
        `${index + 1}. ${entry.alias} -> ${entry.agentId} (${entry.projectPath})`
      );
      return {
        success: true,
        output: `可用 project agent alias：\n${lines.join('\n')}\n\n使用：<##@agent:alias##>`,
      };
    }

    if (cmd.type === CommandType.AGENT_NEW || cmd.type === CommandType.AGENT_SWITCH || cmd.type === CommandType.AGENT_DELETE) {
      return {
        success: true,
        output: 'ledger 模式已启用：不再使用 new/switch/delete 会话命令；默认始终使用 latest 上下文。',
      };
    }

    const action = typeof cmd.params?.action === 'string' ? String(cmd.params.action).trim() : '';
    if (!ctx.updateContext || !ctx.channelId) {
      return {
        success: true,
        output: '已切换到 Project Agent（当前入口未绑定 channel context 持久化）。',
      };
    }

    // <##@agent##> : switch to default project agent context and keep persistent.
    if (!action) {
      ctx.updateContext(ctx.channelId, 'business', 'finger-project-agent');
      return {
        success: true,
        output: '已切换到 Project Agent（持久生效，直到 <##@system##>）。',
      };
    }

    // <##@agent:system##> : quick return to system
    if (action.toLowerCase() === 'system') {
      ctx.updateContext(ctx.channelId, 'system', 'finger-system-agent');
      return {
        success: true,
        output: '已切换到 System Agent（持久生效）。',
      };
    }

    const resolved = await resolveProjectAgentAlias(action);
    if (!resolved.ok) {
      if (resolved.reason === 'ambiguous') {
        const options = resolved.candidates.map((entry) => `- ${entry.alias} (${entry.projectPath})`).join('\n');
        return {
          success: true,
          output: `alias "${action}" 命中多个项目，请指定完整 alias：\n${options}`,
        };
      }
      const top = resolved.candidates.slice(0, 8).map((entry) => `- ${entry.alias}`).join('\n');
      return {
        success: true,
        output: top
          ? `未找到 alias "${action}"。\n可用 alias：\n${top}`
          : `未找到 alias "${action}"，且当前没有已监控项目。`,
      };
    }

    const entry = resolved.entry;
    const targetAgentId = entry.agentId || 'finger-project-agent';
    ctx.updateContext(
      ctx.channelId,
      'business',
      targetAgentId,
      { projectId: entry.projectId, projectPath: entry.projectPath, projectAlias: entry.alias },
    );

    return {
      success: true,
      output: `已切换到 Project Agent: ${entry.alias} -> ${targetAgentId}（持久生效）`,
    };
  }
}
