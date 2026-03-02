import { Command } from 'commander';
import { IflowBaseAgent, type IflowGovernedOptions } from '../agents/sdk/iflow-base.js';
import { IflowInteractiveAgent } from '../agents/sdk/iflow-interactive.js';
import { runIflowCapabilityTest } from '../agents/sdk/iflow-capability-test.js';
import * as readline from 'readline';
import { FINGER_PATHS } from '../core/finger-paths.js';

interface CommonOptions {
  cwd?: string;
  addDir?: string[];
  capability?: string; // reserved
  agentId?: string;
  allowTool?: string[];
  denyTool?: string[];
  permissionMode?: 'auto' | 'manual' | 'selective';
  approvalMode?: 'default' | 'autoEdit' | 'yolo' | 'plan';
  injectCapability?: string[];
  injectAllCapabilities?: boolean;
  commandNamespace?: string;
  fingerSessionId?: string;
  sessionMapPath?: string;
}

interface SessionUseOptions extends CommonOptions {
  create: boolean;
}

interface SessionContextOptions extends CommonOptions {
  create: boolean;
  useMapped?: boolean;
  includeCatalog?: boolean;
}

function buildBaseAgent(options: CommonOptions): IflowBaseAgent {
  const governed: IflowGovernedOptions = {
    autoStartProcess: true,
    cwd: options.cwd,
    permissionMode: options.permissionMode,
    fingerSessionId: options.fingerSessionId,
    sessionMapPath: options.sessionMapPath,
    sessionAgentId: options.agentId,
    sessionSettings: options.addDir ? { add_dirs: options.addDir } : undefined,
    governance: {
      toolPolicy: {
        allowedTools: options.allowTool,
        disallowedTools: options.denyTool,
        approvalMode: options.approvalMode,
      },
      commandPolicy: {
        injectCapabilities: options.injectAllCapabilities || (options.injectCapability?.length ?? 0) > 0,
        capabilityIds: options.injectCapability,
        commandNamespace: options.commandNamespace,
      },
    },
  };
  return new IflowBaseAgent(governed);
}

export function registerIflowCommand(program: Command): void {
  const iflow = program.command('iflow').description('iFlow SDK 能力封装 CLI');

  // status: 基础接口 - 查询连接状态
  iflow
    .command('status')
    .description('查询 iFlow 连接状态和 session 信息')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .option('--allow-tool <tools...>', '工具白名单（session_settings.allowed_tools）')
    .option('--deny-tool <tools...>', '工具黑名单（session_settings.disallowed_tools）')
    .option('--permission-mode <mode>', '客户端权限模式 auto|manual|selective')
    .option('--approval-mode <mode>', 'session_settings.permission_mode: default|autoEdit|yolo|plan')
    .option('--inject-capability <ids...>', '按 capability id 注入为 iFlow command')
    .option('--inject-all-capabilities', '注入所有可用 capability 为 iFlow command')
    .option('--command-namespace <prefix>', '注入 command 名称前缀', 'cap_')
    .option('--finger-session-id <id>', '绑定 finger 会话 ID')
    .option('--agent-id <id>', '绑定/复用会话时使用的 Agent ID 作用域', 'iflow-default')
    .option('--session-map-path <path>', '自定义 finger↔iflow 会话映射文件路径')
    .action(async (options: CommonOptions) => {
      const agent = buildBaseAgent(options);
      try {
        const info = await agent.initialize();
        console.log(JSON.stringify({
          connected: info.connected,
          sessionId: info.sessionId,
          cwd: info.cwd,
          addDirs: info.addDirs,
          commands: info.availableCommands.length,
          agents: info.availableAgents.length,
          skills: info.availableSkills.length,
          mcpServers: info.availableMcpServers.length,
          configuredAllowedTools: info.configuredAllowedTools,
          configuredDisallowedTools: info.configuredDisallowedTools,
          injectedCommands: info.injectedCommands,
          injectedCapabilities: info.injectedCapabilities,
          fingerSessionId: info.fingerSessionId ?? null,
          sessionAgentId: info.sessionAgentId,
          sessionProvider: info.sessionProvider,
        }, null, 2));
      } catch (err) {
        console.error('Failed to connect:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        await agent.disconnect();
      }
    });

  // tools: 基础接口 - 查询 MCP 服务器列表 (iFlow 的工具以 MCP 形式提供)
  iflow
    .command('tools')
    .description('查询 iFlow 可用工具列表 (MCP Servers)')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .option('--allow-tool <tools...>', '工具白名单（session_settings.allowed_tools）')
    .option('--deny-tool <tools...>', '工具黑名单（session_settings.disallowed_tools）')
    .option('--permission-mode <mode>', '客户端权限模式 auto|manual|selective')
    .option('--approval-mode <mode>', 'session_settings.permission_mode: default|autoEdit|yolo|plan')
    .option('--inject-capability <ids...>', '按 capability id 注入为 iFlow command')
    .option('--inject-all-capabilities', '注入所有可用 capability 为 iFlow command')
    .option('--command-namespace <prefix>', '注入 command 名称前缀', 'cap_')
    .option('--agent-id <id>', '绑定/复用会话时使用的 Agent ID 作用域', 'iflow-default')
    .action(async (options: CommonOptions) => {
      const agent = buildBaseAgent(options);
      try {
        const info = await agent.initialize();
        console.log(JSON.stringify({
          cwd: info.cwd,
          addDirs: info.addDirs,
          tools: info.availableMcpServers,
          configuredAllowedTools: info.configuredAllowedTools,
          configuredDisallowedTools: info.configuredDisallowedTools,
          count: info.availableMcpServers.length,
        }, null, 2));
      } catch (err) {
        console.error('Failed to get tools:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        await agent.disconnect();
      }
    });

  // capabilities: 基础接口 - 查询所有能力
  iflow
    .command('capabilities')
    .description('查询 iFlow commands/agents/skills 能力列表')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .option('--allow-tool <tools...>', '工具白名单（session_settings.allowed_tools）')
    .option('--deny-tool <tools...>', '工具黑名单（session_settings.disallowed_tools）')
    .option('--permission-mode <mode>', '客户端权限模式 auto|manual|selective')
    .option('--approval-mode <mode>', 'session_settings.permission_mode: default|autoEdit|yolo|plan')
    .option('--inject-capability <ids...>', '按 capability id 注入为 iFlow command')
    .option('--inject-all-capabilities', '注入所有可用 capability 为 iFlow command')
    .option('--command-namespace <prefix>', '注入 command 名称前缀', 'cap_')
    .option('--agent-id <id>', '绑定/复用会话时使用的 Agent ID 作用域', 'iflow-default')
    .action(async (options: CommonOptions) => {
      const agent = buildBaseAgent(options);
      try {
        const info = await agent.initialize();
        console.log(JSON.stringify({
          cwd: info.cwd,
          addDirs: info.addDirs,
          commands: info.availableCommands,
          agents: info.availableAgents,
          skills: info.availableSkills,
          mcpServers: info.availableMcpServers,
          injectedCommands: info.injectedCommands,
          injectedCapabilities: info.injectedCapabilities,
        }, null, 2));
      } catch (err) {
        console.error('Failed to get capabilities:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        await agent.disconnect();
      }
    });

  iflow
    .command('governance')
    .description('查看当前 iFlow 工具治理与 command 注入结果')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .option('--allow-tool <tools...>', '工具白名单（session_settings.allowed_tools）')
    .option('--deny-tool <tools...>', '工具黑名单（session_settings.disallowed_tools）')
    .option('--permission-mode <mode>', '客户端权限模式 auto|manual|selective')
    .option('--approval-mode <mode>', 'session_settings.permission_mode: default|autoEdit|yolo|plan')
    .option('--inject-capability <ids...>', '按 capability id 注入为 iFlow command')
    .option('--inject-all-capabilities', '注入所有可用 capability 为 iFlow command')
    .option('--command-namespace <prefix>', '注入 command 名称前缀', 'cap_')
    .option('--agent-id <id>', '绑定/复用会话时使用的 Agent ID 作用域', 'iflow-default')
    .action(async (options: CommonOptions) => {
      const agent = buildBaseAgent(options);
      try {
        const info = await agent.initialize();
        const injected = agent.getInjectedCapabilityCommands();
        console.log(JSON.stringify({
          sessionId: info.sessionId,
          configuredAllowedTools: info.configuredAllowedTools,
          configuredDisallowedTools: info.configuredDisallowedTools,
          injectedCount: injected.length,
          injected,
          sessionAgentId: info.sessionAgentId,
          sessionProvider: info.sessionProvider,
          commandCount: info.availableCommands.length,
          mcpCount: info.availableMcpServers.length,
        }, null, 2));
      } catch (err) {
        console.error('Governance inspect failed:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        await agent.disconnect();
      }
    });

  iflow
    .command('session-bindings')
    .description('列出 finger↔iflow 会话映射')
    .option('--agent-id <id>', '仅查看指定 Agent ID 的会话映射', 'iflow-default')
    .option('--session-map-path <path>', '自定义会话映射文件路径')
    .action(async (options: CommonOptions) => {
      const agent = buildBaseAgent(options);
      try {
        console.log(JSON.stringify({
          path: options.sessionMapPath || FINGER_PATHS.config.file.iflowSessionMap,
          bindings: agent.listSessionBindings(),
        }, null, 2));
      } catch (err) {
        console.error('List session bindings failed:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  iflow
    .command('session-use')
    .description('按 finger session 选择/创建 iFlow session 并绑定')
    .requiredOption('--finger-session-id <id>', 'Finger 会话 ID')
    .option('--no-create', '映射不存在时不自动创建')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .option('--allow-tool <tools...>', '工具白名单（session_settings.allowed_tools）')
    .option('--deny-tool <tools...>', '工具黑名单（session_settings.disallowed_tools）')
    .option('--permission-mode <mode>', '客户端权限模式 auto|manual|selective')
    .option('--approval-mode <mode>', 'session_settings.permission_mode: default|autoEdit|yolo|plan')
    .option('--inject-capability <ids...>', '按 capability id 注入为 iFlow command')
    .option('--inject-all-capabilities', '注入所有可用 capability 为 iFlow command')
    .option('--command-namespace <prefix>', '注入 command 名称前缀', 'cap_')
    .option('--agent-id <id>', '绑定/复用会话时使用的 Agent ID 作用域', 'iflow-default')
    .option('--session-map-path <path>', '自定义会话映射文件路径')
    .action(async (options: SessionUseOptions) => {
      const agent = buildBaseAgent(options);
      try {
        await agent.initialize(true);
        const iflowSessionId = await agent.useMappedSession(options.fingerSessionId!, options.create);
        const binding = agent.bindFingerSession(options.fingerSessionId!, iflowSessionId);
        console.log(JSON.stringify({
          fingerSessionId: binding.fingerSessionId,
          agentId: binding.agentId,
          provider: binding.provider,
          iflowSessionId: binding.iflowSessionId,
          updatedAt: binding.updatedAt,
        }, null, 2));
      } catch (err) {
        console.error('Use mapped session failed:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        await agent.disconnect();
      }
    });

  iflow
    .command('session-unbind')
    .description('删除 finger↔iflow 会话映射')
    .requiredOption('--finger-session-id <id>', 'Finger 会话 ID')
    .option('--agent-id <id>', '删除指定 Agent ID 的会话映射', 'iflow-default')
    .option('--session-map-path <path>', '自定义会话映射文件路径')
    .action((options: CommonOptions) => {
      const agent = buildBaseAgent(options);
      try {
        const removed = agent.removeSessionBinding(options.fingerSessionId!);
        console.log(JSON.stringify({
          fingerSessionId: options.fingerSessionId,
          removed,
        }, null, 2));
      } catch (err) {
        console.error('Session unbind failed:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  iflow
    .command('session-context')
    .description('获取 iFlow 会话上下文快照（可选按 finger 会话绑定/恢复）')
    .option('--finger-session-id <id>', 'Finger 会话 ID')
    .option('--use-mapped', '优先加载 finger 对应的已绑定 iFlow 会话')
    .option('--no-create', '映射不存在时不自动创建会话（仅当 --use-mapped 时有效）')
    .option('--include-catalog', '输出 commands/skills/mcp 详细目录')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .option('--allow-tool <tools...>', '工具白名单（session_settings.allowed_tools）')
    .option('--deny-tool <tools...>', '工具黑名单（session_settings.disallowed_tools）')
    .option('--permission-mode <mode>', '客户端权限模式 auto|manual|selective')
    .option('--approval-mode <mode>', 'session_settings.permission_mode: default|autoEdit|yolo|plan')
    .option('--inject-capability <ids...>', '按 capability id 注入为 iFlow command')
    .option('--inject-all-capabilities', '注入所有可用 capability 为 iFlow command')
    .option('--command-namespace <prefix>', '注入 command 名称前缀', 'cap_')
    .option('--agent-id <id>', '绑定/复用会话时使用的 Agent ID 作用域', 'iflow-default')
    .option('--session-map-path <path>', '自定义会话映射文件路径')
    .action(async (options: SessionContextOptions) => {
      const agent = buildBaseAgent(options);
      try {
        await agent.initialize(true);

        let activeSessionId = agent.getInfo().sessionId;
        if (options.useMapped && options.fingerSessionId) {
          activeSessionId = await agent.useMappedSession(options.fingerSessionId, options.create);
        } else if (!activeSessionId) {
          activeSessionId = await agent.createNewSession();
        }

        if (options.fingerSessionId && activeSessionId) {
          agent.bindFingerSession(options.fingerSessionId, activeSessionId);
        }

        const info = agent.getInfo();
        const binding = options.fingerSessionId ? agent.getSessionBinding(options.fingerSessionId) : null;
        const models = await agent.getModels();

        const payload: Record<string, unknown> = {
          connected: info.connected,
          sessionId: info.sessionId,
          fingerSessionId: options.fingerSessionId ?? null,
          sessionAgentId: info.sessionAgentId,
          sessionProvider: info.sessionProvider,
          binding,
          configuredAllowedTools: info.configuredAllowedTools,
          configuredDisallowedTools: info.configuredDisallowedTools,
          injectedCommands: info.injectedCommands,
          injectedCapabilities: info.injectedCapabilities,
          availableCounts: {
            commands: info.availableCommands.length,
            agents: info.availableAgents.length,
            skills: info.availableSkills.length,
            mcpServers: info.availableMcpServers.length,
            models: models.length,
          },
          models: models.map((item) => ({
            id: item.id,
            name: item.name,
            capabilities: item.capabilities,
          })),
        };

        if (options.includeCatalog) {
          payload.catalog = {
            commands: await agent.getCommandCatalog(),
            skills: await agent.getSkillCatalog(),
            mcpServers: await agent.getMcpCatalog(),
          };
        }

        console.log(JSON.stringify(payload, null, 2));
      } catch (err) {
        console.error('Session context failed:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        await agent.disconnect();
      }
    });

  iflow
    .command('capability-test')
    .description('执行 iFlow SDK 标准能力测试并输出能力清单')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .action(async (options: CommonOptions) => {
      try {
        const report = await runIflowCapabilityTest({
          cwd: options.cwd,
          addDir: options.addDir,
        });
        console.log(JSON.stringify(report, null, 2));
      } catch (err) {
        console.error('Capability test failed:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // run: 交互接口 - 非交互式任务执行
  iflow
    .command('run')
    .description('执行任务并返回结果')
    .requiredOption('-t, --task <task>', '任务内容')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .option('--allow-tool <tools...>', '工具白名单（session_settings.allowed_tools）')
    .option('--deny-tool <tools...>', '工具黑名单（session_settings.disallowed_tools）')
    .option('--permission-mode <mode>', '客户端权限模式 auto|manual|selective')
    .option('--approval-mode <mode>', 'session_settings.permission_mode: default|autoEdit|yolo|plan')
    .option('--inject-capability <ids...>', '按 capability id 注入为 iFlow command')
    .option('--inject-all-capabilities', '注入所有可用 capability 为 iFlow command')
    .option('--command-namespace <prefix>', '注入 command 名称前缀', 'cap_')
    .option('--finger-session-id <id>', '绑定 finger 会话 ID')
    .option('--agent-id <id>', '绑定/复用会话时使用的 Agent ID 作用域', 'iflow-default')
    .option('--session-map-path <path>', '自定义会话映射文件路径')
    .option('-c, --capability <path>', '能力描述文件路径（暂未实现）')
    .action(async (options: CommonOptions & { task: string }) => {
      const base = buildBaseAgent(options);
      const client = base.getClient();
      const agent = new IflowInteractiveAgent(client);
      try {
        await base.initialize();
        if (options.fingerSessionId) {
          await base.useMappedSession(options.fingerSessionId, true);
        }
        console.log('Executing task...');
        const result = await agent.interact(options.task, {
          onAssistantChunk: (chunk) => process.stdout.write(chunk),
        });
        console.log('\n\nResult:', JSON.stringify(result, null, 2));
      } catch (err) {
        console.error('\nTask failed:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        await base.disconnect();
      }
    });

  // chat: 交互接口 - 交互式聊天
  iflow
    .command('chat')
    .description('进入交互式聊天模式')
    .option('-d, --cwd <dir>', '工作目录')
    .option('--add-dir <dirs...>', '额外包含目录')
    .option('--allow-tool <tools...>', '工具白名单（session_settings.allowed_tools）')
    .option('--deny-tool <tools...>', '工具黑名单（session_settings.disallowed_tools）')
    .option('--permission-mode <mode>', '客户端权限模式 auto|manual|selective')
    .option('--approval-mode <mode>', 'session_settings.permission_mode: default|autoEdit|yolo|plan')
    .option('--inject-capability <ids...>', '按 capability id 注入为 iFlow command')
    .option('--inject-all-capabilities', '注入所有可用 capability 为 iFlow command')
    .option('--command-namespace <prefix>', '注入 command 名称前缀', 'cap_')
    .option('--finger-session-id <id>', '绑定 finger 会话 ID')
    .option('--agent-id <id>', '绑定/复用会话时使用的 Agent ID 作用域', 'iflow-default')
    .option('--session-map-path <path>', '自定义会话映射文件路径')
    .action(async (options: CommonOptions) => {
      const base = buildBaseAgent(options);
      const client = base.getClient();
      const agent = new IflowInteractiveAgent(client);
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const question = (prompt: string): Promise<string> => 
        new Promise(resolve => rl.question(prompt, resolve));

      try {
        await base.initialize();
        if (options.fingerSessionId) {
          await base.useMappedSession(options.fingerSessionId, true);
        }
        console.log('Connected to iFlow. Type "exit" to quit.\n');

        for (;;) {
          const input = await question('You: ');
          if (input.toLowerCase() === 'exit') break;

          process.stdout.write('Assistant: ');
          await agent.interact(input, {
            onAssistantChunk: (chunk) => process.stdout.write(chunk),
          });
          console.log('\n');
        }
      } catch (err) {
        console.error('\nChat error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        rl.close();
        await base.disconnect();
      }
    });
}
