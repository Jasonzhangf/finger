import { Command } from 'commander';
import { OrchestrationDaemon } from '../orchestration/daemon.js';
import fetch from 'node-fetch';
import { loadModuleManifest } from '../orchestration/module-manifest.js';

interface SendOptions {
  target: string;
  message: string;
  blocking?: boolean;
  sender?: string;
}

interface RegisterModuleOptions {
  file?: string;
  manifest?: string;
}

interface AgentInstanceView {
  id: string;
  agentId: string;
  status: string;
  currentLoad: number;
}

export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Orchestration daemon control');

  // All commands are non-blocking (fire and forget)
  
  daemon
    .command('start')
    .description('Start the orchestration daemon (non-blocking)')
    .action(() => {
      const d = new OrchestrationDaemon();
      d.start().then(() => process.exit(0)).catch((err) => {
        console.error('Failed to start daemon:', err);
        process.exit(1);
      });
    });

  daemon
    .command('stop')
    .description('Stop the orchestration daemon')
    .action(() => {
      const d = new OrchestrationDaemon();
      d.stop().then(() => process.exit(0)).catch((err) => {
        console.error('Failed to stop daemon:', err);
        process.exit(1);
      });
    });

  daemon
    .command('restart')
    .description('Restart the orchestration daemon')
    .action(() => {
      const d = new OrchestrationDaemon();
      d.restart().then(() => process.exit(0)).catch((err) => {
        console.error('Failed to restart daemon:', err);
        process.exit(1);
      });
    });

  daemon
    .command('status')
    .description('Show daemon status and registered modules')
    .option('-j, --json', 'Output as JSON')
    .action((options: { json?: boolean }) => {
      const d = new OrchestrationDaemon();
      const running = d.isRunning();
      
      if (!running) {
        console.log('Daemon: not running');
        process.exit(0);
        return;
      }

      const config = d.getConfig();
      
      fetch(`http://localhost:${config.port}/api/v1/modules`, { timeout: 5000 })
        .then(res => res.json())
        .then(data => {
          if (options.json) {
            console.log(JSON.stringify({ running: true, port: config.port, ...data }, null, 2));
          } else {
            console.log(`Daemon: running on port ${config.port}`);
            console.log(`WebSocket: port ${config.wsPort}`);
            console.log(`\nInputs: ${(data as { inputs: { id: string }[] }).inputs.length}`);
            (data as { inputs: { id: string }[] }).inputs.forEach((i) => console.log(`  - ${i.id}`));
            console.log(`\nOutputs: ${(data as { outputs: { id: string }[] }).outputs.length}`);
            (data as { outputs: { id: string }[] }).outputs.forEach((o) => console.log(`  - ${o.id}`));
          }
          process.exit(0);
        })
        .catch(() => {
          console.log('Daemon: process exists but not responding');
          process.exit(1);
        });
    });

  daemon
    .command('send')
    .description('Send a message to a module (default: non-blocking)')
    .requiredOption('-t, --target <id>', 'Target module ID')
    .requiredOption('-m, --message <json>', 'Message as JSON string')
    .option('-b, --blocking', 'Wait for result', false)
    .option('-s, --sender <id>', 'Sender module ID (for callback)')
    .action((options: SendOptions) => {
      const d = new OrchestrationDaemon();
      const config = d.getConfig();
      
      try {
        const message = JSON.parse(options.message);
        fetch(`http://localhost:${config.port}/api/v1/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: options.target,
            message,
            blocking: options.blocking,
            sender: options.sender,
          }),
        })
          .then(res => res.json())
          .then(data => {
            console.log(JSON.stringify(data, null, 2));
            process.exit(0);
          })
          .catch(error => {
            console.error('Failed to send message:', error);
            process.exit(1);
          });
      } catch (error) {
        console.error('Invalid JSON message:', error);
        process.exit(1);
      }
    });

  daemon
    .command('register-module')
    .description('Register module from JS file or module.json')
    .option('-f, --file <path>', 'Path to module JS file')
    .option('-m, --manifest <path>', 'Path to module.json')
    .action((options: RegisterModuleOptions) => {
      const d = new OrchestrationDaemon();
      const config = d.getConfig();
      let filePath = options.file;

      if (!filePath && !options.manifest) {
        console.error('Missing option: --file <path> or --manifest <path>');
        process.exit(1);
        return;
      }

      if (options.manifest) {
        try {
          const resolved = loadModuleManifest(options.manifest);
          filePath = resolved.entryPath;
        } catch (error) {
          console.error('Invalid module manifest:', error instanceof Error ? error.message : String(error));
          process.exit(1);
          return;
        }
      }
      
      fetch(`http://localhost:${config.port}/api/v1/module/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      })
        .then(res => res.json())
        .then(data => {
          console.log((data as { success?: boolean; error?: string }).success ? 'Module registered successfully' : 'Failed: ' + (data as { error?: string }).error);
          process.exit(0);
        })
        .catch(error => {
          console.error('Failed to register module:', error);
          process.exit(1);
        });
    });

  daemon
    .command('list')
    .description('List all registered modules')
    .action(() => {
      const d = new OrchestrationDaemon();
      const config = d.getConfig();
      
      fetch(`http://localhost:${config.port}/api/v1/modules`)
        .then(res => res.json())
        .then(data => {
          const d = data as { inputs: { id: string }[]; outputs: { id: string }[]; modules: { id: string; type: string }[] };
          console.log('Inputs:');
          d.inputs.forEach((i) => console.log(`  - ${i.id}`));
          console.log('\nOutputs:');
          d.outputs.forEach((o) => console.log(`  - ${o.id}`));
          console.log('\nModules:');
          d.modules.forEach((m) => console.log(`  - ${m.id} (${m.type})`));
          process.exit(0);
        })
        .catch(() => {
          console.log('Daemon not running');
          process.exit(1);
        });
    });

  // Agent pool management
  const agent = daemon
    .command('agent')
    .description('Runtime agent management');

  agent
    .command('spawn <agentId>')
    .description('Spawn a new agent instance')
    .action((agentId: string) => {
      import('../orchestration/agent-pool.js')
        .then(async ({ AgentPool }) => {
          const pool = AgentPool.getInstance();
          const instance = await pool.spawnAgent(agentId, { maxConcurrent: 5 });
          console.log(`Spawned agent ${agentId} with ID ${instance.id}`);
          process.exit(0);
        })
        .catch(err => {
          console.error('Failed to spawn agent:', err);
          process.exit(1);
        });
    });

  agent
    .command('list')
    .description('List all agent instances')
    .action(() => {
      import('../orchestration/agent-pool.js')
        .then(({ AgentPool }) => {
          const pool = AgentPool.getInstance();
          const instances = pool.getAllInstances() as AgentInstanceView[];

          if (instances.length === 0) {
            console.log('No agent instances');
            process.exit(0);
            return;
          }

          instances.forEach((inst) => {
            console.log(`${inst.agentId}:${inst.id} - ${inst.status} (load: ${inst.currentLoad})`);
          });
          process.exit(0);
        })
        .catch((err) => {
          console.error('Failed to list agent instances:', err);
          process.exit(1);
        });
    });

  agent
    .command('kill <instanceId>')
    .description('Kill an agent instance')
    .action((instanceId: string) => {
      import('../orchestration/agent-pool.js')
        .then(({ AgentPool }) => {
          const pool = AgentPool.getInstance();
          const killed = pool.killInstance(instanceId);
          console.log(killed ? `Killed ${instanceId}` : `Instance ${instanceId} not found`);
          process.exit(0);
        })
        .catch((err) => {
          console.error('Failed to kill agent instance:', err);
          process.exit(1);
        });
    });
}
