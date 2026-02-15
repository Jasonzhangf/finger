import { Command } from 'commander';
import { OrchestrationDaemon } from '../orchestration/daemon.js';
import fetch from 'node-fetch';

interface SendOptions {
  target: string;
  message: string;
  blocking?: boolean;
}

interface ModuleFileOptions {
  file: string;
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
    .description('Send a message to a module')
    .requiredOption('-t, --target <id>', 'Target module ID (input/output)')
    .requiredOption('-m, --message <json>', 'Message JSON string')
    .option('-b, --blocking', 'Wait for response (blocking mode)')
    .action(async (options: SendOptions) => {
      try {
        const message = JSON.parse(options.message);
        const url = `http://localhost:5521/api/v1/message`;
        const body = {
          target: options.target,
          message,
          blocking: options.blocking || false
        };

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        const result = await res.json();
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error('Send failed:', err);
      }
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
}
