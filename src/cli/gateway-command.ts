import type { Command } from 'commander';

const DEFAULT_DAEMON_URL = process.env.FINGER_HUB_URL || 'http://localhost:5521';

export function registerGatewayCommand(program: Command): void {
  const gateway = program.command('gateway').description('CLI gateway management');

  gateway
    .command('list')
    .description('List installed gateways')
    .option('-u, --url <url>', 'Daemon URL', DEFAULT_DAEMON_URL)
    .action(async (options: { url: string }) => {
      const payload = await requestJson(`${options.url}/api/v1/gateways`);
      console.log(JSON.stringify(payload, null, 2));
      process.exit(0);
    });

  gateway
    .command('inspect')
    .description('Inspect gateway details')
    .argument('<id>', 'Gateway ID')
    .option('-u, --url <url>', 'Daemon URL', DEFAULT_DAEMON_URL)
    .action(async (id: string, options: { url: string }) => {
      const payload = await requestJson(`${options.url}/api/v1/gateways/${encodeURIComponent(id)}`);
      console.log(JSON.stringify(payload, null, 2));
      process.exit(0);
    });

  gateway
    .command('probe')
    .description('Probe gateway command/help/version')
    .argument('<id>', 'Gateway ID')
    .option('-u, --url <url>', 'Daemon URL', DEFAULT_DAEMON_URL)
    .action(async (id: string, options: { url: string }) => {
      const payload = await requestJson(`${options.url}/api/v1/gateways/${encodeURIComponent(id)}/probe`);
      console.log(JSON.stringify(payload, null, 2));
      process.exit(0);
    });

  gateway
    .command('register')
    .description('Install gateway module from directory')
    .requiredOption('-f, --file <path>', 'Gateway module directory path')
    .option('-u, --url <url>', 'Daemon URL', DEFAULT_DAEMON_URL)
    .action(async (options: { file: string; url: string }) => {
      const payload = await requestJson(`${options.url}/api/v1/gateways/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: options.file }),
      });
      console.log(JSON.stringify(payload, null, 2));
      process.exit(0);
    });

  gateway
    .command('unregister')
    .description('Unregister gateway module')
    .requiredOption('-i, --id <id>', 'Gateway ID')
    .option('-u, --url <url>', 'Daemon URL', DEFAULT_DAEMON_URL)
    .action(async (options: { id: string; url: string }) => {
      const payload = await requestJson(
        `${options.url}/api/v1/gateways/${encodeURIComponent(options.id)}`,
        { method: 'DELETE' },
      );
      console.log(JSON.stringify(payload, null, 2));
      process.exit(0);
    });

  gateway
    .command('reload')
    .description('Reload gateway modules')
    .option('-u, --url <url>', 'Daemon URL', DEFAULT_DAEMON_URL)
    .action(async (options: { url: string }) => {
      const payload = await requestJson(`${options.url}/api/v1/gateways/reload`, { method: 'POST' });
      console.log(JSON.stringify(payload, null, 2));
      process.exit(0);
    });

  gateway
    .command('input')
    .description('Dispatch inbound message to gateway')
    .argument('<id>', 'Gateway ID')
    .requiredOption('-m, --message <json>', 'Inbound message JSON')
    .option('-t, --target <moduleId>', 'Override target module')
    .option('-s, --sender <moduleId>', 'Sender module for callback')
    .option('-b, --blocking', 'Wait for target result')
    .option('-u, --url <url>', 'Daemon URL', DEFAULT_DAEMON_URL)
    .action(
      async (
        id: string,
        options: { message: string; target?: string; sender?: string; blocking?: boolean; url: string },
      ) => {
        const message = parseJson(options.message);
        const payload = await requestJson(`${options.url}/api/v1/gateways/${encodeURIComponent(id)}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            target: options.target,
            sender: options.sender,
            blocking: options.blocking ?? false,
          }),
        });
        console.log(JSON.stringify(payload, null, 2));
        process.exit(0);
      },
    );
}

async function requestJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, init);
  const raw = await response.text();
  let payload: unknown = {};
  if (raw.trim().length > 0) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Invalid JSON response from daemon (${response.status})`);
    }
  }

  if (!response.ok) {
    if (isRecord(payload) && typeof payload.error === 'string') {
      throw new Error(payload.error);
    }
    throw new Error(`HTTP ${response.status}`);
  }
  return payload;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON: ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
