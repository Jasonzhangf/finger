#!/usr/bin/env node
import { Command } from 'commander';
import { AgentDaemon } from './agent-daemon.js';

const program = new Command();

program.name('agent-daemon').description('ReAct Agent Daemon');

program
  .command('start')
  .description('Start an agent daemon')
  .requiredOption('--id <id>', 'Agent ID')
  .requiredOption('--name <name>', 'Agent name')
  .requiredOption('--mode <mode>', 'Agent mode')
  .requiredOption('--port <port>', 'Port')
  .option('--system-prompt <prompt>', 'System prompt')
  .option('--cwd <dir>', 'Working directory')
  .option('--finger-daemon-url <url>', 'Finger daemon URL')
  .action(async (options) => {
    const daemon = new AgentDaemon({
      agentId: options.id,
      agentName: options.name,
      mode: options.mode,
      port: parseInt(options.port, 10),
      systemPrompt: options.systemPrompt,
      cwd: options.cwd,
      fingerDaemonUrl: options.fingerDaemonUrl || 'http://localhost:5521',
      allowedTools: undefined,
    });

    await daemon.start();
    console.log(`Agent daemon started on port ${options.port}`);
  });

program.parse();
