import { writeFileSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { Command } from 'commander';
import {
  CliCapabilityDescriptor,
  ensureCliCapabilityDir,
  installCliCapabilityDescriptor,
  installCliCapabilityFromCommand,
  isCliCommandAvailable,
  listInstalledCliCapabilities,
  parseCliCapabilityDescriptor,
  probeCliCapability,
  removeCliCapabilityDescriptor,
  resolveAvailableCliCapabilities,
} from '../tools/external/cli-capability-registry.js';

const DEFAULT_DAEMON_URL = process.env.FINGER_HUB_URL || 'http://localhost:9999';
const DEFAULT_AGENT_ID = process.env.FINGER_CAPABILITY_AGENT_ID || 'manual-cli';

interface DaemonToolResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

interface CapabilityRunCommandOptions {
  url: string;
  agent: string;
  authorizationToken?: string;
  local?: boolean;
}

interface CapabilityInspectOptions {
  json?: boolean;
}

interface CapabilityVerifyOptions {
  json?: boolean;
}

export interface ExecuteCliCapabilityOptions {
  daemonUrl?: string;
  agentId?: string;
  authorizationToken?: string;
  local?: boolean;
}

export type RegisterCliCapabilityAliasOptions = ExecuteCliCapabilityOptions;

export function resolveCapabilityToolName(capabilityId: string): string {
  return `capability.${capabilityId}`;
}

export async function registerCliCapabilityAliases(
  program: Command,
  options: RegisterCliCapabilityAliasOptions = {},
): Promise<{ loaded: string[]; skipped: Array<{ id: string; reason: string }> }> {
  const loaded: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const capabilities = resolveAvailableCliCapabilities();

  for (const capability of capabilities) {
    if (program.commands.some((cmd) => cmd.name() === capability.id)) {
      skipped.push({ id: capability.id, reason: 'command name conflict' });
      continue;
    }

    program
      .command(capability.id)
      .description(`[capability] ${capability.description} (exec: ${capability.command})`)
      .argument('[args...]', 'Arguments forwarded to capability CLI')
      .allowUnknownOption(true)
      .action(async (args: string[] | undefined) => {
        const forwardedArgs = Array.isArray(args) ? args : extractForwardedArgs(capability.id);
        try {
          const exitCode = await executeCliCapability(capability, forwardedArgs, options);
          process.exit(exitCode);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[Capability] ${capability.id} failed: ${message}`);
          process.exit(1);
        }
      });

    loaded.push(capability.id);
  }

  return { loaded, skipped };
}

export function registerCapabilityCommand(program: Command): void {
  const capability = program.command('capability').description('全局 CLI 能力管理');

  capability
    .command('list')
    .description('列出能力描述、可用性、文档发现状态')
    .action(() => {
      const installed = listInstalledCliCapabilities();
      if (installed.length === 0) {
        console.log('No CLI capabilities installed');
        process.exit(0);
        return;
      }

      for (const item of installed) {
        const available = isCliCommandAvailable(item.descriptor.command);
        const docs = item.descriptor.docs;
        const readme = docs?.readmePath ? 'yes' : 'no';
        const cliDoc = docs?.cliDocPath ? 'yes' : 'no';
        console.log(
          `${item.descriptor.id} (${item.descriptor.version}) source=${item.source} command=${item.descriptor.command} available=${available} readme=${readme} cliDoc=${cliDoc}`,
        );
      }
      process.exit(0);
    });

  capability
    .command('inspect')
    .description('分阶段披露：查看某能力的 L1/L2/L3 信息')
    .argument('<id>', 'Capability id')
    .option('-j, --json', 'JSON 输出')
    .action((id: string, options: CapabilityInspectOptions) => {
      const descriptor = resolveCapabilityById(id);
      if (!descriptor) {
        console.error(`[Capability] Not found: ${id}`);
        process.exit(1);
        return;
      }

      const payload = {
        level1: {
          id: descriptor.id,
          name: descriptor.name,
          description: descriptor.description,
          command: descriptor.command,
        },
        level2: {
          help: renderProbeCommand(descriptor.command, descriptor.helpArgs ?? ['help']),
          version: renderProbeCommand(descriptor.command, descriptor.versionArgs ?? ['--version']),
        },
        level3: {
          readmePath: descriptor.docs?.readmePath ?? null,
          cliDocPath: descriptor.docs?.cliDocPath ?? null,
          readmeExcerpt: descriptor.docs?.readmeExcerpt ?? null,
          cliDocExcerpt: descriptor.docs?.cliDocExcerpt ?? null,
        },
        runtimeDescription: descriptor.runtimeDescription ?? null,
      };

      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`L1 ${payload.level1.name} (${payload.level1.id})`);
        console.log(`用途: ${payload.level1.description}`);
        console.log(`入口: ${payload.level1.command}`);
        console.log(`L2 help: ${payload.level2.help}`);
        console.log(`L2 version: ${payload.level2.version}`);
        console.log(`L3 README: ${payload.level3.readmePath ?? '未提供'}`);
        console.log(`L3 cli.md: ${payload.level3.cliDocPath ?? '未提供'}`);
        if (payload.level3.readmeExcerpt) {
          console.log('\nREADME 摘要:');
          console.log(payload.level3.readmeExcerpt);
        }
        if (payload.level3.cliDocExcerpt) {
          console.log('\ncli.md 摘要:');
          console.log(payload.level3.cliDocExcerpt);
        }
      }
      process.exit(0);
    });

  capability
    .command('verify')
    .description('验证 command/help/version 可执行性')
    .argument('<id>', 'Capability id')
    .option('-j, --json', 'JSON 输出')
    .action((id: string, options: CapabilityVerifyOptions) => {
      const descriptor = resolveCapabilityById(id);
      if (!descriptor) {
        console.error(`[Capability] Not found: ${id}`);
        process.exit(1);
        return;
      }

      const commandAvailable = isCliCommandAvailable(descriptor.command);
      const helpProbe = probeCliCapability(descriptor, 'help');
      const versionProbe = probeCliCapability(descriptor, 'version');
      const ok = commandAvailable && (!helpProbe.supported || helpProbe.ok) && (!versionProbe.supported || versionProbe.ok);
      const payload = {
        id: descriptor.id,
        command: descriptor.command,
        commandAvailable,
        help: helpProbe,
        version: versionProbe,
        ok,
      };

      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`command available: ${commandAvailable}`);
        console.log(`help probe: supported=${helpProbe.supported} ok=${helpProbe.ok} exit=${helpProbe.exitCode}`);
        console.log(`version probe: supported=${versionProbe.supported} ok=${versionProbe.ok} exit=${versionProbe.exitCode}`);
        console.log(`overall: ${ok ? 'ok' : 'failed'}`);
      }
      process.exit(ok ? 0 : 1);
    });

  capability
    .command('run')
    .description('运行某个能力 CLI（默认走 daemon 工具链）')
    .argument('<id>', 'Capability id')
    .argument('[args...]', 'Arguments forwarded to capability CLI')
    .allowUnknownOption(true)
    .option('-u, --url <url>', 'Daemon URL', DEFAULT_DAEMON_URL)
    .option('-a, --agent <id>', 'Assignee agent ID', DEFAULT_AGENT_ID)
    .option('--authorization-token <token>', 'Authorization token for protected tools')
    .option('--local', 'Run locally (bypass daemon policy chain)')
    .action(async (id: string, args: string[] | undefined, options: CapabilityRunCommandOptions) => {
      const descriptor = resolveCapabilityById(id);
      if (!descriptor) {
        console.error(`[Capability] Not found: ${id}`);
        process.exit(1);
        return;
      }
      if (!isCliCommandAvailable(descriptor.command)) {
        console.error(`[Capability] Command not available: ${descriptor.command}`);
        process.exit(1);
        return;
      }

      const forwardedArgs = Array.isArray(args) ? args : extractRunArgs(id);
      try {
        const exitCode = await executeCliCapability(descriptor, forwardedArgs, {
          daemonUrl: options.url,
          agentId: options.agent,
          authorizationToken: options.authorizationToken,
          local: options.local,
        });
        process.exit(exitCode);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Capability] run failed: ${message}`);
        process.exit(1);
      }
    });

  capability
    .command('register')
    .description('注册能力描述（支持目录 module.json 或 legacy *.capability.json）')
    .requiredOption('-f, --file <path>', 'Path to capability module dir or descriptor file')
    .action((options: { file: string }) => {
      try {
        const installed = installCliCapabilityDescriptor(options.file);
        console.log(`Capability installed: ${installed.descriptor.id}`);
        console.log(`Module: ${installed.filePath}`);
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Capability] Register failed: ${message}`);
        process.exit(1);
      }
    });

  capability
    .command('register-cli')
    .description('快速注册全局 CLI 能力（自动创建 module.json + README.md + cli.md）')
    .requiredOption('-i, --id <id>', 'Capability id')
    .requiredOption('-n, --name <name>', 'Capability name')
    .requiredOption('-c, --command <cmd>', 'Global CLI command')
    .requiredOption('-d, --description <desc>', 'Capability description')
    .option('-v, --version <version>', 'Capability version', '1.0.0')
    .option('-a, --default-args <args>', 'Default args (comma separated)')
    .option('--help-args <args>', 'Help probe args (comma separated)', 'help')
    .option('--version-args <args>', 'Version probe args (comma separated)', '--version')
    .option('--no-version-probe', 'Disable version probe for tools without version command')
    .action(
      (options: {
        id: string;
        name: string;
        command: string;
        description: string;
        version: string;
        defaultArgs?: string;
        helpArgs?: string;
        versionArgs?: string;
        versionProbe?: boolean;
      }) => {
        try {
          const defaultArgs =
            options.defaultArgs?.split(',').map((item) => item.trim()).filter((item) => item.length > 0) || [];
          const helpArgs =
            options.helpArgs?.split(',').map((item) => item.trim()).filter((item) => item.length > 0) || ['help'];
          const versionArgs =
            options.versionProbe === false
              ? []
              : options.versionArgs?.split(',').map((item) => item.trim()).filter((item) => item.length > 0) || [
                  '--version',
                ];
          const installed = installCliCapabilityFromCommand(
            options.id,
            options.name,
            options.command,
            options.description,
            options.version,
            defaultArgs,
            {
              helpArgs,
              versionArgs,
            },
          );
          console.log(`Capability installed: ${installed.descriptor.id}`);
          console.log(`Module: ${installed.filePath}`);
          process.exit(0);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[Capability] register-cli failed: ${message}`);
          process.exit(1);
        }
      },
    );

  capability
    .command('unregister')
    .description('移除能力目录（<id>/）与 legacy 描述文件')
    .requiredOption('-i, --id <id>', 'Capability id')
    .action((options: { id: string }) => {
      const removed = removeCliCapabilityDescriptor(options.id);
      if (!removed) {
        console.error(`[Capability] Not found: ${options.id}`);
        process.exit(1);
        return;
      }
      console.log(`Capability removed: ${options.id}`);
      process.exit(0);
    });
}

export async function executeCliCapability(
  capability: CliCapabilityDescriptor,
  args: string[],
  options: ExecuteCliCapabilityOptions = {},
): Promise<number> {
  if (options.local) {
    return executeCliCapabilityLocally(capability, args);
  }

  const daemonUrl = options.daemonUrl ?? DEFAULT_DAEMON_URL;
  const response = await fetch(`${daemonUrl}/api/v1/tools/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: options.agentId ?? DEFAULT_AGENT_ID,
      toolName: resolveCapabilityToolName(capability.id),
      input: {
        args,
      },
      authorizationToken: options.authorizationToken,
    }),
  });

  const payload = (await response.json()) as { success?: boolean; result?: unknown; error?: string };
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  const result = payload.result;
  if (!isDaemonToolResult(result)) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

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

  console.log(`[Capability] exit=${result.exitCode} timedOut=${result.timedOut} durationMs=${result.durationMs}`);
  return toProcessExitCode(result.exitCode, result.ok);
}

function resolveCapabilityById(id: string): CliCapabilityDescriptor | null {
  return (
    listInstalledCliCapabilities()
      .map((item) => item.descriptor)
      .find((item) => item.id === id) ?? null
  );
}

function renderProbeCommand(command: string, args: string[]): string {
  if (args.length === 0) {
    return `${command} (disabled)`;
  }
  return `${command} ${args.join(' ')}`;
}

function executeCliCapabilityLocally(capability: CliCapabilityDescriptor, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(capability.command, [...(capability.defaultArgs || []), ...args], {
      stdio: 'inherit',
      shell: false,
    });

    child.on('close', (code) => {
      resolve(typeof code === 'number' ? code : 1);
    });

    child.on('error', () => {
      resolve(1);
    });
  });
}

function isDaemonToolResult(value: unknown): value is DaemonToolResult {
  return (
    isRecord(value) &&
    typeof value.ok === 'boolean' &&
    typeof value.exitCode === 'number' &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string' &&
    typeof value.timedOut === 'boolean' &&
    typeof value.durationMs === 'number'
  );
}

function toProcessExitCode(exitCode: number, ok: boolean): number {
  if (ok) return 0;
  if (exitCode >= 1 && exitCode <= 255) return exitCode;
  return 1;
}

function extractForwardedArgs(commandName: string): string[] {
  const args = process.argv.slice(2);
  const idx = args.indexOf(commandName);
  if (idx < 0) return [];
  return args.slice(idx + 1);
}

function extractRunArgs(capabilityId: string): string[] {
  const args = process.argv.slice(2);
  const runIndex = args.findIndex((item) => item === 'run');
  if (runIndex < 0) return [];
  const idIndex = args.findIndex((item, index) => index > runIndex && item === capabilityId);
  if (idIndex < 0) return [];
  return args.slice(idIndex + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export { CliCapabilityDescriptor };
export {
  ensureCliCapabilityDir,
  installCliCapabilityDescriptor,
  installCliCapabilityFromCommand,
  isCliCommandAvailable,
  listInstalledCliCapabilities,
  parseCliCapabilityDescriptor,
  removeCliCapabilityDescriptor,
  resolveAvailableCliCapabilities,
};

export function writeCapabilityTemplate(targetPath: string): void {
  const descriptor: CliCapabilityDescriptor = {
    id: 'my-cli-capability',
    name: 'My CLI Capability',
    version: '1.0.0',
    description: 'Describe what this external CLI tool does for agents',
    command: 'my-cli-command',
    defaultArgs: [],
    helpArgs: ['help'],
    versionArgs: ['--version'],
    readmeFile: 'README.md',
    cliDocFile: 'cli.md',
    enabled: true,
  };
  writeFileSync(targetPath, JSON.stringify(descriptor, null, 2), 'utf-8');
}

export function installCapabilityDescriptorFile(sourcePath: string): void {
  installCliCapabilityDescriptor(sourcePath);
}

export function resolveDefaultCapabilityModulePath(capabilityId: string): string {
  return path.join(ensureCliCapabilityDir(), capabilityId, 'module.json');
}
