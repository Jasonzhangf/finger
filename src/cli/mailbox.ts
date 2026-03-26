import { Command } from 'commander';
import ora from 'ora';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('Mailbox');

const MAILBOX_BASE_URL = process.env.FINGER_HUB_URL || 'http://localhost:9999';

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

export function registerMailboxCommand(program: Command): void {
  const mailbox = program.command('mailbox').description('Mailbox management');

  mailbox
    .command('notify')
    .description('Append a mailbox notification to an agent mailbox (script-friendly)')
    .requiredOption('-t, --target-agent <id>', 'Target agent ID (e.g. finger-system-agent)')
    .requiredOption('--message <text>', 'Notification text')
    .option('--title <text>', 'Notification title', 'Scheduled Mailbox Notification')
    .option('--priority <level>', 'Priority: high|medium|low', 'medium')
    .option('--sender <id>', 'Sender identifier', 'mailbox-cli')
    .option('--source <id>', 'Notification source', 'mailbox-cli')
    .option('--channel <id>', 'Optional channel id')
    .option('-s, --session-id <id>', 'Optional session id')
    .option('--wake', 'After writing mailbox, send a direct wake message to target agent', true)
    .option('--no-wake', 'Only write mailbox, do not send wake message')
    .action(async (options: {
      targetAgent: string;
      message: string;
      title: string;
      priority: string;
      sender: string;
      source: string;
      channel?: string;
      sessionId?: string;
      wake: boolean;
    }) => {
      try {
        const notifyPayload = {
          targetAgentId: options.targetAgent,
          message: options.message,
          title: options.title,
          priority: options.priority,
          sender: options.sender,
          source: options.source,
          ...(options.channel ? { channel: options.channel } : {}),
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        };

        const notifyRes = await fetch(`${MAILBOX_BASE_URL}/api/v1/heartbeat/mailbox/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(notifyPayload),
        });

        const notifyData = await notifyRes.json();
        if (!notifyRes.ok || notifyData?.success === false) {
          throw new Error(
            typeof notifyData?.error === 'string'
              ? notifyData.error
              : `notify failed with status ${notifyRes.status}`,
          );
        }

        let wakeResult: Record<string, unknown> | null = null;
        if (options.wake) {
          const wakeText = `Mailbox notification arrived (messageId=${String(notifyData.messageId ?? '')}). Please check mailbox and handle pending notification(s).`;
          const wakeRes = await fetch(`${MAILBOX_BASE_URL}/api/v1/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              target: options.targetAgent,
              sender: options.sender || 'mailbox-cli',
              message: {
                text: wakeText,
                metadata: {
                  role: 'system',
                  source: options.source || 'mailbox-cli',
                  systemDirectInject: true,
                  deliveryMode: 'direct',
                },
              },
              blocking: false,
            }),
          });
          const wakeData = await wakeRes.json();
          if (!wakeRes.ok) {
            throw new Error(
              typeof wakeData?.error === 'string'
                ? wakeData.error
                : `wake dispatch failed with status ${wakeRes.status}`,
            );
          }
          wakeResult = wakeData as Record<string, unknown>;
        }

        clog.log(JSON.stringify({
          success: true,
          mailbox: notifyData,
          ...(wakeResult ? { wake: wakeResult } : {}),
        }, null, 2));
        process.exit(0);
      } catch (err) {
        clog.error('Failed to send mailbox notification:', err);
        process.exit(1);
      }
    });

  mailbox
    .command('list')
    .description('List messages in mailbox')
    .option('-t, --target <id>', 'Filter by target module')
    .option('-s, --status <status>', 'Filter by status (pending|processing|completed|failed)')
    .option('-l, --limit <n>', 'Limit number of results', '10')
    .action(async (options: { target?: string; status?: string; limit: string }) => {
      try {
        const params = new URLSearchParams();
        if (options.target) params.set('target', options.target);
        if (options.status) params.set('status', options.status);
        params.set('limit', options.limit);

        const res = await fetch(`${MAILBOX_BASE_URL}/api/v1/mailbox?${params}`);
        const data = await res.json();
        
        clog.log('\nMailbox Messages:');
        clog.log('-'.repeat(60));
        for (const msg of data.messages || []) {
          clog.log(`[${msg.id}] ${renderStatus(msg.status)} ${msg.target}`);
          clog.log(`  Created: ${new Date(msg.createdAt).toLocaleString()}`);
          if (msg.error) {
            clog.log(`  Error: ${msg.error}`);
          }
          clog.log('');
        }
      } catch (err) {
        clog.error('Failed to list messages:', err);
      }
    });

  mailbox
    .command('get <id>')
    .description('Get message details')
    .action(async (id: string) => {
      try {
        const res = await fetch(`${MAILBOX_BASE_URL}/api/v1/mailbox/${id}`);
        if (res.status === 404) {
          clog.error(`Message ${id} not found`);
          return;
        }
        const data = await res.json();
        
        clog.log('\nMessage Details:');
        clog.log('-'.repeat(60));
        clog.log(`ID:       ${data.id}`);
        clog.log(`Target:   ${data.target}`);
        clog.log(`Status:   ${renderStatus(data.status)}`);
        clog.log(`Created:  ${new Date(data.createdAt).toLocaleString()}`);
        clog.log(`Updated:  ${new Date(data.updatedAt).toLocaleString()}`);
        clog.log('');
        clog.log('Content:');
        clog.log(JSON.stringify(data.content, null, 2));
        
        if (data.result) {
          clog.log('\nResult:');
          clog.log(JSON.stringify(data.result, null, 2));
        }
        
        if (data.error) {
          clog.log('\nError:');
          clog.log(data.error);
        }
      } catch (err) {
        clog.error('Failed to get message:', err);
      }
    });

  mailbox
    .command('wait <id>')
    .description('Wait for message completion with animation')
    .option('-t, --timeout <ms>', 'Timeout in milliseconds', '60000')
    .action(async (id: string, options: { timeout: string }) => {
      const timeout = parseInt(options.timeout, 10);
      const start = Date.now();
      const spinner = ora('Waiting...').start();

      const checkStatus = async (): Promise<void> => {
        try {
          const res = await fetch(`${MAILBOX_BASE_URL}/api/v1/mailbox/${id}`);
          if (res.status === 404) {
            spinner.fail(`Message ${id} not found`);
            return;
          }
          const data = await res.json();
          
          spinner.text = `${renderStatus(data.status)} (${Math.floor((Date.now() - start) / 1000)}s)`;
          
          if (data.status === 'completed') {
            spinner.succeed('Completed');
            clog.log('\nResult:');
            clog.log(JSON.stringify(data.result, null, 2));
            return;
          }
          
          if (data.status === 'failed') {
            spinner.fail('Failed');
            clog.log('\nError:', data.error);
            return;
          }

          if (Date.now() - start > timeout) {
            spinner.warn('Timeout');
            clog.log('\nCurrent status:', data.status);
            return;
          }

          await new Promise(r => setTimeout(r, 1000));
          await checkStatus();
        } catch (err) {
          spinner.fail(String(err));
        }
      };

      await checkStatus();
    });

  mailbox
    .command('clear')
    .description('Clear completed messages from mailbox')
    .action(async () => {
      try {
        const res = await fetch(`${MAILBOX_BASE_URL}/api/v1/mailbox/clear`, { method: 'POST' });
        const data = await res.json();
        clog.log(data.message || 'Mailbox cleared');
      } catch (err) {
        clog.error('Failed to clear mailbox:', err);
      }
    });
}
