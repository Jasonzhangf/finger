import { Command } from 'commander';
import fetch from 'node-fetch';
import ora from 'ora';

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

        const res = await fetch(`http://localhost:5521/api/v1/mailbox?${params}`);
        const data = await res.json();
        
        console.log('\nMailbox Messages:');
        console.log('-'.repeat(60));
        for (const msg of data.messages || []) {
          console.log(`[${msg.id}] ${renderStatus(msg.status)} ${msg.target}`);
          console.log(`  Created: ${new Date(msg.createdAt).toLocaleString()}`);
          if (msg.error) {
            console.log(`  Error: ${msg.error}`);
          }
          console.log('');
        }
      } catch (err) {
        console.error('Failed to list messages:', err);
      }
    });

  mailbox
    .command('get <id>')
    .description('Get message details')
    .action(async (id: string) => {
      try {
        const res = await fetch(`http://localhost:5521/api/v1/mailbox/${id}`);
        if (res.status === 404) {
          console.error(`Message ${id} not found`);
          return;
        }
        const data = await res.json();
        
        console.log('\nMessage Details:');
        console.log('-'.repeat(60));
        console.log(`ID:       ${data.id}`);
        console.log(`Target:   ${data.target}`);
        console.log(`Status:   ${renderStatus(data.status)}`);
        console.log(`Created:  ${new Date(data.createdAt).toLocaleString()}`);
        console.log(`Updated:  ${new Date(data.updatedAt).toLocaleString()}`);
        console.log('');
        console.log('Content:');
        console.log(JSON.stringify(data.content, null, 2));
        
        if (data.result) {
          console.log('\nResult:');
          console.log(JSON.stringify(data.result, null, 2));
        }
        
        if (data.error) {
          console.log('\nError:');
          console.log(data.error);
        }
      } catch (err) {
        console.error('Failed to get message:', err);
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
          const res = await fetch(`http://localhost:5521/api/v1/mailbox/${id}`);
          if (res.status === 404) {
            spinner.fail(`Message ${id} not found`);
            return;
          }
          const data = await res.json();
          
          spinner.text = `${renderStatus(data.status)} (${Math.floor((Date.now() - start) / 1000)}s)`;
          
          if (data.status === 'completed') {
            spinner.succeed('Completed');
            console.log('\nResult:');
            console.log(JSON.stringify(data.result, null, 2));
            return;
          }
          
          if (data.status === 'failed') {
            spinner.fail('Failed');
            console.log('\nError:', data.error);
            return;
          }

          if (Date.now() - start > timeout) {
            spinner.warn('Timeout');
            console.log('\nCurrent status:', data.status);
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
        const res = await fetch('http://localhost:5521/api/v1/mailbox/clear', { method: 'POST' });
        const data = await res.json();
        console.log(data.message || 'Mailbox cleared');
      } catch (err) {
        console.error('Failed to clear mailbox:', err);
      }
    });
}
