import type { Command } from 'commander';
import { createDefaultInternalToolRegistry, ShellExecOutput } from '../tools/internal/index.js';

interface ToolShellOptions {
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  json?: boolean;
}

interface ToolRunOptions {
  input?: string;
  agent?: string;
  url: string;
  authorizationToken?: string;
  local?: boolean;
}

interface ToolPolicyOptions {
  url: string;
}

interface ToolPolicyMutateOptions extends ToolPolicyOptions {
  agent: string;
  tool: string;
}

interface ToolRolePolicyOptions extends ToolPolicyOptions {
  agent: string;
  role: string;
}

interface ToolAuthRequiredOptions extends ToolPolicyOptions {
  tool: string;
  required: string;
}

interface ToolAuthorizeOptions extends ToolPolicyOptions {
  agent: string;
  tool: string;
  issuedBy: string;
  ttlMs?: number;
  maxUses?: number;
}

interface ToolAgentConfigOptions extends ToolPolicyOptions {
  dir?: string;
}

const internalToolRegistry = createDefaultInternalToolRegistry();

export function registerToolCommand(program: Command): void {
  const tool = program.command('tool').description('内部工具执行入口');
  const defaultDaemonUrl = process.env.FINGER_HUB_URL || 'http://localhost:9999';

  tool
    .command('list')
    .description('列出可用内部工具')
    .action(() => {
      const tools = internalToolRegistry.list();
      if (tools.length === 0) {
        console.log('No internal tools registered');
        process.exit(0);
        return;
      }

      for (const item of tools) {
        console.log(`${item.name} - ${item.description}`);
      }
      process.exit(0);
    });

  tool
    .command('shell')
    .description('执行 shell.exec 工具')
    .argument('[command...]', 'Shell command tokens (alternative to --command)')
    .option('-c, --command <cmd>', 'Command string')
    .option('-w, --cwd <dir>', 'Working directory')
    .option('-t, --timeout-ms <ms>', 'Timeout in milliseconds', parseIntOption)
    .option('-j, --json', 'Output JSON')
    .action(async (commandParts: string[], options: ToolShellOptions) => {
      const command = resolveShellCommand(commandParts, options.command);
      if (!command) {
        console.error('[tool shell] command is required');
        process.exit(1);
        return;
      }

      try {
        const result = (await internalToolRegistry.execute('shell.exec', {
          command,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
        })) as ShellExecOutput;

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.stdout.trim().length > 0) {
            process.stdout.write(result.stdout);
            if (!result.stdout.endsWith('\n')) {
              process.stdout.write('\n');
            }
          }
          if (result.stderr.trim().length > 0) {
            process.stderr.write(result.stderr);
            if (!result.stderr.endsWith('\n')) {
              process.stderr.write('\n');
            }
          }
          console.log(
            `[tool shell] exit=${result.exitCode} timedOut=${result.timedOut} durationMs=${result.durationMs}`,
          );
        }

        process.exit(toProcessExitCode(result.exitCode, result.ok));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tool shell] failed: ${message}`);
        process.exit(1);
      }
    });

  tool
    .command('run')
    .description('执行工具（默认走 daemon，与 agent 执行链一致）')
    .argument('<name>', 'Tool name')
    .option('-i, --input <json>', 'Tool input JSON string')
    .option('-a, --agent <id>', 'Assignee agent ID (required unless --local)')
    .option('-u, --url <url>', 'Daemon URL', defaultDaemonUrl)
    .option('--authorization-token <token>', 'Authorization token for protected tools')
    .option('--local', 'Run locally for debug (bypass daemon policy chain)')
    .action(async (name: string, options: ToolRunOptions) => {
      try {
        const input = options.input ? parseJsonInput(options.input) : {};
        const result = options.local
          ? await internalToolRegistry.execute(name, input)
          : await executeToolThroughDaemon(options, name, input);
        console.log(JSON.stringify(result, null, 2));
        process.exit(resolveExitCodeFromResult(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tool run] failed: ${message}`);
        process.exit(1);
      }
    });

  tool
    .command('policy')
    .description('查看 agent 工具白名单/黑名单')
    .argument('<agent>', 'Agent ID')
    .option('-u, --url <url>', 'Daemon URL', defaultDaemonUrl)
    .action(async (agent: string, options: ToolPolicyOptions) => {
      try {
        const response = await fetch(`${options.url}/api/v1/tools/agents/${encodeURIComponent(agent)}/policy`);
        const payload = (await response.json()) as { success?: boolean; policy?: unknown; error?: string };
        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        console.log(JSON.stringify(payload.policy, null, 2));
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tool policy] failed: ${message}`);
        process.exit(1);
      }
    });

  registerToolPolicyMutation(tool, 'grant', '授权 agent 使用工具', defaultDaemonUrl);
  registerToolPolicyMutation(tool, 'revoke', '撤销 agent 工具授权', defaultDaemonUrl);
  registerToolPolicyMutation(tool, 'deny', '加入 agent 工具黑名单', defaultDaemonUrl);
  registerToolPolicyMutation(tool, 'allow', '从 agent 工具黑名单移除', defaultDaemonUrl);

  tool
    .command('presets')
    .description('查看内置角色工具策略模板')
    .option('-u, --url <url>', 'Daemon URL', defaultDaemonUrl)
    .action(async (options: ToolPolicyOptions) => {
      try {
        const response = await fetch(`${options.url}/api/v1/tools/agents/presets`);
        const payload = (await response.json()) as { success?: boolean; presets?: unknown; error?: string };
        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        console.log(JSON.stringify(payload.presets, null, 2));
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tool presets] failed: ${message}`);
        process.exit(1);
      }
    });

  tool
    .command('role-policy')
    .description('应用角色工具策略模板（例如 reviewer 只读）')
    .requiredOption('-a, --agent <id>', 'Agent ID')
    .requiredOption('-r, --role <role>', 'Role preset name')
    .option('-u, --url <url>', 'Daemon URL', defaultDaemonUrl)
    .action(async (options: ToolRolePolicyOptions) => {
      try {
        const response = await fetch(
          `${options.url}/api/v1/tools/agents/${encodeURIComponent(options.agent)}/role-policy`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: options.role }),
          },
        );
        const payload = (await response.json()) as { success?: boolean; policy?: unknown; error?: string };
        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        console.log(JSON.stringify(payload.policy, null, 2));
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tool role-policy] failed: ${message}`);
        process.exit(1);
      }
    });

  tool
    .command('auth-require')
    .description('设置工具是否需要授权令牌')
    .requiredOption('-t, --tool <name>', 'Tool name')
    .requiredOption('-r, --required <true|false>', 'Whether token is required')
    .option('-u, --url <url>', 'Daemon URL', defaultDaemonUrl)
    .action(async (options: ToolAuthRequiredOptions) => {
      try {
        const required = parseBooleanOption(options.required);
        const response = await fetch(`${options.url}/api/v1/tools/${encodeURIComponent(options.tool)}/authorization`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ required }),
        });
        const payload = (await response.json()) as { success?: boolean; error?: string };
        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        console.log(JSON.stringify({ tool: options.tool, required }, null, 2));
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tool auth-require] failed: ${message}`);
        process.exit(1);
      }
    });

  tool
    .command('authorize')
    .description('签发工具调用授权令牌')
    .requiredOption('-a, --agent <id>', 'Agent ID')
    .requiredOption('-t, --tool <name>', 'Tool name')
    .requiredOption('-i, --issued-by <id>', 'Issuer identifier')
    .option('--ttl-ms <ms>', 'Authorization token TTL', parseIntOption)
    .option('--max-uses <n>', 'Maximum uses', parseIntOption)
    .option('-u, --url <url>', 'Daemon URL', defaultDaemonUrl)
    .action(async (options: ToolAuthorizeOptions) => {
      try {
        const response = await fetch(`${options.url}/api/v1/tools/authorizations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: options.agent,
            toolName: options.tool,
            issuedBy: options.issuedBy,
            ttlMs: options.ttlMs,
            maxUses: options.maxUses,
          }),
        });
        const payload = (await response.json()) as { success?: boolean; authorization?: unknown; error?: string };
        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        console.log(JSON.stringify(payload.authorization, null, 2));
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tool authorize] failed: ${message}`);
        process.exit(1);
      }
    });

  tool
    .command('revoke-auth')
    .description('吊销授权令牌')
    .argument('<token>', 'Authorization token')
    .option('-u, --url <url>', 'Daemon URL', defaultDaemonUrl)
    .action(async (token: string, options: ToolPolicyOptions) => {
      try {
        const response = await fetch(
          `${options.url}/api/v1/tools/authorizations/${encodeURIComponent(token)}`,
          { method: 'DELETE' },
        );
        const payload = (await response.json()) as { success?: boolean; error?: string };
        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        console.log(JSON.stringify({ revoked: true, token }, null, 2));
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tool revoke-auth] failed: ${message}`);
        process.exit(1);
      }
    });

  tool
    .command('config-list')
    .description('查看当前加载的 agent.json 配置')
    .option('-u, --url <url>', 'Daemon URL', defaultDaemonUrl)
    .action(async (options: ToolPolicyOptions) => {
      try {
        const response = await fetch(`${options.url}/api/v1/agents/configs`);
        const payload = (await response.json()) as { success?: boolean; error?: string };
        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        console.log(JSON.stringify(payload, null, 2));
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tool config-list] failed: ${message}`);
        process.exit(1);
      }
    });

  tool
    .command('config-schema')
    .description('查看 agent.json JSON Schema')
    .option('-u, --url <url>', 'Daemon URL', defaultDaemonUrl)
    .action(async (options: ToolPolicyOptions) => {
      try {
        const response = await fetch(`${options.url}/api/v1/agents/configs/schema`);
        const payload = (await response.json()) as { success?: boolean; error?: string };
        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        console.log(JSON.stringify(payload, null, 2));
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tool config-schema] failed: ${message}`);
        process.exit(1);
      }
    });

  tool
    .command('config-reload')
    .description('重载 agent.json 配置')
    .option('-d, --dir <path>', 'Optional config directory override')
    .option('-u, --url <url>', 'Daemon URL', defaultDaemonUrl)
    .action(async (options: ToolAgentConfigOptions) => {
      try {
        const response = await fetch(`${options.url}/api/v1/agents/configs/reload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: options.dir }),
        });
        const payload = (await response.json()) as { success?: boolean; error?: string };
        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        console.log(JSON.stringify(payload, null, 2));
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tool config-reload] failed: ${message}`);
        process.exit(1);
      }
    });
}

function resolveShellCommand(commandParts: string[], commandOption?: string): string | null {
  const fromOption = typeof commandOption === 'string' ? commandOption.trim() : '';
  if (fromOption.length > 0) return fromOption;

  const fromParts = commandParts.join(' ').trim();
  return fromParts.length > 0 ? fromParts : null;
}

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

function parseBooleanOption(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`Invalid boolean: ${value}`);
}

async function executeToolThroughDaemon(
  options: ToolRunOptions,
  toolName: string,
  input: unknown,
): Promise<unknown> {
  if (!options.agent) {
    throw new Error('agent is required unless --local is specified');
  }

  const response = await fetch(`${options.url}/api/v1/tools/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: options.agent,
      toolName,
      input,
      authorizationToken: options.authorizationToken,
    }),
  });
  const payload = (await response.json()) as { success?: boolean; result?: unknown; error?: string };
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload.result;
}

function parseJsonInput(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON input: ${message}`);
  }
}

function toProcessExitCode(exitCode: number, ok: boolean): number {
  if (ok) return 0;
  if (exitCode >= 1 && exitCode <= 255) return exitCode;
  return 1;
}

function resolveExitCodeFromResult(result: unknown): number {
  if (isRecord(result) && typeof result.ok === 'boolean') {
    if (result.ok) return 0;
    if (typeof result.exitCode === 'number' && result.exitCode >= 1 && result.exitCode <= 255) {
      return result.exitCode;
    }
    return 1;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function registerToolPolicyMutation(
  tool: Command,
  action: 'grant' | 'revoke' | 'deny' | 'allow',
  description: string,
  defaultDaemonUrl: string,
): void {
  tool
    .command(action)
    .description(description)
    .requiredOption('-a, --agent <id>', 'Agent ID')
    .requiredOption('-t, --tool <name>', 'Tool name')
    .option('-u, --url <url>', 'Daemon URL', defaultDaemonUrl)
    .action(async (options: ToolPolicyMutateOptions) => {
      try {
        const response = await fetch(
          `${options.url}/api/v1/tools/agents/${encodeURIComponent(options.agent)}/${action}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toolName: options.tool }),
          },
        );
        const payload = (await response.json()) as { success?: boolean; policy?: unknown; error?: string };
        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        console.log(JSON.stringify(payload.policy, null, 2));
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tool ${action}] failed: ${message}`);
        process.exit(1);
      }
    });
}
