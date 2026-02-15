import { Command } from 'commander';
import { OrchestrationDaemon } from '../orchestration/daemon.js';
import { AgentPool } from '../orchestration/agent-pool.js';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import ora from 'ora';

interface SendOptions {
  target: string;
  message: string;
  blocking?: boolean;
  sender?: string;
}

interface ChatOptions {
  target: string;
  sender?: string;
}

interface ModuleFileOptions {
  file: string;
}

interface AgentAddOptions {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  port: number;
  systemPrompt?: string;
  cwd?: string;
  autoStart?: boolean;
}

function parseJsonMessage(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // fallback: treat as plain text
    return { content: raw };
  }
}

async function sendMessage(
  target: string,
  message: unknown,
  blocking: boolean,
  sender?: string
): Promise<any> {
  const url = 'http://localhost:5521/api/v1/message';
  const body = {
    target,
    message,
    blocking,
    sender,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return await res.json();
}

async function getMailboxMessage(messageId: string): Promise<any> {
  const res = await fetch(`http://localhost:5521/api/v1/mailbox/${messageId}`);
  if (!res.ok) {
    throw new Error(`Failed to get mailbox message: ${res.status}`);
  }
  return await res.json();
}

function renderStatus(status: string): string {
  switch (status) {
    case 'pending':
      return '⏳ pending';
    case 'processing':
      return '🔄 processing';
    case 'completed':
      return '✅ completed';
    case 'failed':
      return '❌ failed';
    default:
      return status;
  }
}

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command('daemon').description('Orchestration daemon control');

  daemon
    .command('start')
    .description('Start the orchestration daemon')
    .action(async () => {
      const d = new OrchestrationDaemon();
      await d.start();
    });

  daemon
    .command('stop')
    .description('Stop the orchestration daemon')
    .action(async () => {
      const d = new OrchestrationDaemon();
      await d.stop();
    });

  daemon
    .command('restart')
    .description('Restart the orchestration daemon')
    .action(async () => {
      const d = new OrchestrationDaemon();
      await d.restart();
    });

  daemon
    .command('status')
    .description('Show daemon status and registered modules')
    .action(async () => {
      const d = new OrchestrationDaemon();
      const running = d.isRunning();
      console.log(`Daemon is ${running ? 'running' : 'stopped'}`);
      if (!running) return;

      try {
        const res = await fetch('http://localhost:5521/api/v1/modules');
        const data = await res.json();
        console.log('\nRegistered Modules:');
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        console.error('Failed to fetch module list:', err);
      }
    });

  daemon
    .command('send')
    .description('Send a message to a module (default: non-blocking)')
    .requiredOption('-t, --target <id>', 'Target module ID (input/output)')
    .requiredOption('-m, --message <json-or-text>', 'Message JSON string or plain text')
    .option('-b, --blocking', 'Wait for immediate response (blocking mode)')
    .option('-s, --sender <name>', 'Sender name')
    .action(async (options: SendOptions) => {
      try {
        const payload = parseJsonMessage(options.message);
        const result = await sendMessage(
          options.target,
          payload,
          options.blocking || false,
          options.sender
        );

        // Non-blocking returns messageId
        if (!options.blocking && result.messageId) {
          console.log(JSON.stringify({
            success: true,
            queued: true,
            messageId: result.messageId,
            hint: `Use: fingerdaemon mailbox get ${result.messageId}`,
          }, null, 2));
          return;
        }

        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error('Send failed:', err);
      }
    });

  daemon
    .command('chat')
    .description('Interactive mode: send messages and watch status via WebSocket')
    .requiredOption('-t, --target <id>', 'Target module ID')
    .option('-s, --sender <name>', 'Sender name', 'cli-user')
    .action(async (options: ChatOptions) => {
      const wsUrl = 'ws://localhost:5522';
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', (err) => reject(err));
      });

      console.log(`Connected to ${wsUrl}`);
      console.log('Interactive mode. Type message and press Enter. Ctrl+C to exit.');

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'messageUpdate' && msg.message) {
            const m = msg.message;
            console.log(`\n[${m.id}] ${renderStatus(m.status)}`);
            if (m.status === 'completed' && m.result) {
              console.log(JSON.stringify(m.result, null, 2));
            }
            if (m.status === 'failed' && m.error) {
              console.error(`[${m.id}] Error: ${m.error}`);
            }
          }
          if (msg.type === 'messageCompleted') {
            console.log(`\n[${msg.messageId}] ✅ completed`);
            if (msg.result) {
              console.log(JSON.stringify(msg.result, null, 2));
            }
          }
        } catch {
          // ignore parsing errors
        }
      });

      process.stdin.setEncoding('utf-8');
      process.stdin.resume();
      process.stdout.write('> ');

      process.stdin.on('data', async (input) => {
        const text = String(input).trim();
        if (!text) {
          process.stdout.write('> ');
          return;
        }

        const spinner = ora('Sending...').start();
        try {
          const result = await sendMessage(
            options.target,
            { content: text },
            false,
            options.sender
          );
          spinner.succeed(`Sent. messageId: ${result.messageId}`);

          // Subscribe this messageId
          ws.send(JSON.stringify({
            type: 'subscribe',
            messageId: result.messageId,
          }));
        } catch (err) {
          spinner.fail(`Send failed: ${err}`);
        }

        process.stdout.write('> ');
      });

      process.on('SIGINT', () => {
        ws.close();
        process.exit(0);
      });
    });

  daemon
    .command('register-module')
    .description('Register a module from a compiled JS file')
    .requiredOption('-f, --file <path>', 'Path to module JS file')
    .action(async (options: ModuleFileOptions) => {
      try {
        const url = 'http://localhost:5521/api/v1/module/register';
        const body = { filePath: options.file };

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        const result = await res.json();
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error('Register module failed:', err);
      }
    });

  daemon
    .command('list')
    .description('List all registered modules')
    .action(async () => {
      try {
        const res = await fetch('http://localhost:5521/api/v1/modules');
        const data = await res.json();
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        console.error('Failed to list modules:', err);
      }
    });

  // Agent pool commands
  const agent = daemon.command('agent').description('Runtime agent management');

  agent
    .command('add')
    .description('Add an agent to the pool')
    .requiredOption('--id <id>', 'Agent ID')
    .requiredOption('--name <name>', 'Agent name')
    .requiredOption('--mode <mode>', 'Agent mode (auto|manual)')
    .requiredOption('--port <port>', 'Agent daemon port')
    .option('--system-prompt <prompt>', 'System prompt')
    .option('--cwd <dir>', 'Working directory')
    .option('--auto-start', 'Auto start when daemon starts')
    .action((options: AgentAddOptions) => {
      const pool = new AgentPool();
      pool.addAgent({
        id: options.id,
        name: options.name,
        mode: options.mode,
        port: options.port,
        systemPrompt: options.systemPrompt,
        cwd: options.cwd,
        autoStart: options.autoStart,
      });
      console.log(`Agent ${options.id} added`);
    });

  agent
    .command('remove <id>')
    .description('Remove an agent from the pool')
    .action(async (id: string) => {
      const pool = new AgentPool();
      await pool.removeAgent(id);
      console.log(`Agent ${id} removed`);
    });

  agent
    .command('start <id>')
    .description('Start an agent')
    .action(async (id: string) => {
      const pool = new AgentPool();
      await pool.startAgent(id);
      console.log(`Agent ${id} started`);
    });

  agent
    .command('stop <id>')
    .description('Stop an agent')
    .action(async (id: string) => {
      const pool = new AgentPool();
      await pool.stopAgent(id);
      console.log(`Agent ${id} stopped`);
    });

  agent
    .command('restart <id>')
    .description('Restart an agent')
    .action(async (id: string) => {
      const pool = new AgentPool();
      await pool.restartAgent(id);
      console.log(`Agent ${id} restarted`);
    });

  agent
    .command('list')
    .description('List all agents')
    .action(() => {
      const pool = new AgentPool();
      const agents = pool.listAgents();
      console.log(JSON.stringify(agents.map(a => ({
        id: a.config.id,
        name: a.config.name,
        mode: a.config.mode,
        port: a.config.port,
        status: a.status,
        autoStart: a.config.autoStart,
      })), null, 2));
    });

  agent
    .command('status <id>')
    .description('Show agent status')
    .action((id: string) => {
      const pool = new AgentPool();
      const agent = pool.getAgentStatus(id);
      if (!agent) {
        console.error(`Agent ${id} not found`);
        return;
      }
      console.log(JSON.stringify({
        id: agent.config.id,
        name: agent.config.name,
        mode: agent.config.mode,
        port: agent.config.port,
        status: agent.status,
        startedAt: agent.startedAt,
      }, null, 2));
    });
}
