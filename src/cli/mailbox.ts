import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import ora from 'ora';
import type { MailboxMessage } from '../blocks/mailbox-block/index.js';
import { withFileMutexSync } from '../core/file-mutex.js';
import { FINGER_HOME } from '../core/finger-paths.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';
import { fetchAgentBusyState } from '../core/agent-runtime-status.js';
import { buildUserNotificationEnvelope } from '../server/modules/mailbox-envelope.js';
import type { ProgressDeliveryPolicy } from '../common/progress-delivery-policy.js';
import { normalizeProgressDeliveryPolicy } from '../common/progress-delivery-policy.js';

const clog = createConsoleLikeLogger('Mailbox');

const MAILBOX_BASE_URL = process.env.FINGER_HUB_URL || 'http://localhost:9999';

type MailboxNotifyPriority = 'high' | 'medium' | 'low';

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

function resolveMailboxNotifyPriority(raw: unknown): MailboxNotifyPriority {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'high' || value === 'low') return value;
  return 'medium';
}

function mapPriorityToMailboxLevel(priority: MailboxNotifyPriority): 0 | 1 | 2 | 3 {
  switch (priority) {
    case 'high':
      return 1;
    case 'low':
      return 3;
    case 'medium':
    default:
      return 2;
  }
}

function parseProgressDeliveryOptions(raw: {
  progressMode?: string;
  progressFields?: string;
}): ProgressDeliveryPolicy | undefined {
  const fieldsSet = new Set(
    String(raw.progressFields ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

  const hasFieldFilter = fieldsSet.size > 0;
  const fields = hasFieldFilter
    ? {
        reasoning: fieldsSet.has('reasoning'),
        bodyUpdates: fieldsSet.has('body') || fieldsSet.has('bodyUpdates'),
        statusUpdate: fieldsSet.has('status') || fieldsSet.has('statusUpdate'),
        toolCalls: fieldsSet.has('tool') || fieldsSet.has('toolCalls'),
        stepUpdates: fieldsSet.has('step') || fieldsSet.has('stepUpdates'),
        progressUpdates: fieldsSet.has('progress') || fieldsSet.has('progressUpdates'),
      }
    : {};

  return normalizeProgressDeliveryPolicy({
    ...(typeof raw.progressMode === 'string' && raw.progressMode.trim().length > 0
      ? { mode: raw.progressMode.trim() }
      : {}),
    ...(hasFieldFilter ? { fields } : {}),
  });
}

function defaultProgressDeliveryForSource(source: string): ProgressDeliveryPolicy | undefined {
  const normalized = source.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes('news') || normalized.includes('email')) {
    return normalizeProgressDeliveryPolicy({ mode: 'result_only' });
  }
  return undefined;
}

function mailboxPath(targetAgentId: string): string {
  return path.join(FINGER_HOME, 'mailbox', targetAgentId, 'inbox.jsonl');
}

function mailboxLockPath(targetAgentId: string): string {
  return `${mailboxPath(targetAgentId)}.lock`;
}

function listMailboxTargets(): string[] {
  const root = path.join(FINGER_HOME, 'mailbox');
  try {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readJsonFileSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listKnownMailboxTargets(): Set<string> {
  const known = new Set<string>([
    'finger-system-agent',
    'finger-project-agent',
    
  ]);

  try {
    const agentsRoot = path.join(FINGER_HOME, 'runtime', 'agents');
    if (fs.existsSync(agentsRoot)) {
      for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) known.add(entry.name);
      }
    }
  } catch {
    // best effort
  }

  try {
    const registryPath = path.join(FINGER_HOME, 'system', 'registry.json');
    const registry = readJsonFileSafe(registryPath);
    const agents = registry?.agents;
    if (agents && typeof agents === 'object' && !Array.isArray(agents)) {
      for (const value of Object.values(agents)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const agentId = (value as Record<string, unknown>).agentId;
        if (typeof agentId === 'string' && agentId.trim().length > 0) known.add(agentId.trim());
      }
    }
  } catch {
    // best effort
  }

  return known;
}

type MailboxDoctorEntry = {
  target: string;
  hasInbox: boolean;
  inboxBytes: number;
  testNamespace: boolean;
  knownTarget: boolean;
  empty: boolean;
};

function scanMailboxDoctor(): {
  mailboxRoot: string;
  entries: MailboxDoctorEntry[];
  knownTargets: string[];
  summary: {
    totalTargets: number;
    emptyTargets: number;
    testNamespaceTargets: number;
    unknownTargets: number;
    candidatePruneTargets: number;
  };
} {
  const mailboxRoot = path.join(FINGER_HOME, 'mailbox');
  const knownTargets = listKnownMailboxTargets();
  const targets = listMailboxTargets();
  const entries: MailboxDoctorEntry[] = targets.map((target) => {
    const inboxPath = path.join(mailboxRoot, target, 'inbox.jsonl');
    const hasInbox = fs.existsSync(inboxPath);
    const inboxBytes = hasInbox ? fs.statSync(inboxPath).size : 0;
    const testNamespace = /^agent-(progress|mailbox-dedup)-/.test(target);
    const knownTarget = knownTargets.has(target);
    const empty = inboxBytes === 0;
    return {
      target,
      hasInbox,
      inboxBytes,
      testNamespace,
      knownTarget,
      empty,
    };
  });

  const summary = {
    totalTargets: entries.length,
    emptyTargets: entries.filter((entry) => entry.empty).length,
    testNamespaceTargets: entries.filter((entry) => entry.testNamespace).length,
    unknownTargets: entries.filter((entry) => !entry.knownTarget).length,
    candidatePruneTargets: entries.filter((entry) => entry.empty && (entry.testNamespace || !entry.knownTarget)).length,
  };

  return {
    mailboxRoot,
    entries,
    knownTargets: Array.from(knownTargets).sort(),
    summary,
  };
}

function backupMailboxRoot(timestamp: string): string | null {
  const mailboxRoot = path.join(FINGER_HOME, 'mailbox');
  if (!fs.existsSync(mailboxRoot)) return null;
  const backupRoot = path.join(FINGER_HOME, 'backups', `mailbox-${timestamp}`);
  const snapshotPath = path.join(backupRoot, 'snapshot');
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.cpSync(mailboxRoot, snapshotPath, { recursive: true, force: true, errorOnExist: false });
  return backupRoot;
}

function applyMailboxDoctorFix(
  report: ReturnType<typeof scanMailboxDoctor>,
  options: { backup: boolean },
): {
  backupPath: string | null;
  quarantinePath: string;
  movedTargets: string[];
  prunedTargets: string[];
} {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = options.backup ? backupMailboxRoot(timestamp) : null;
  const quarantinePath = path.join(FINGER_HOME, 'mailbox-quarantine', timestamp);
  fs.mkdirSync(quarantinePath, { recursive: true });

  const movedTargets: string[] = [];
  const prunedTargets: string[] = [];

  for (const entry of report.entries) {
    const targetDir = path.join(report.mailboxRoot, entry.target);
    if (!fs.existsSync(targetDir)) continue;

    if (entry.testNamespace) {
      const destination = path.join(quarantinePath, entry.target);
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(targetDir, destination);
      movedTargets.push(entry.target);
      continue;
    }

    const shouldPrune = entry.empty && !entry.knownTarget;
    if (shouldPrune) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      prunedTargets.push(entry.target);
    }
  }

  return {
    backupPath,
    quarantinePath,
    movedTargets,
    prunedTargets,
  };
}

function readMessagesFromPath(filePath: string): MailboxMessage[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.trim().length === 0) return [];
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as MailboxMessage);
  } catch {
    return [];
  }
}

function writeMessagesToPath(filePath: string, messages: MailboxMessage[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = messages.length > 0
    ? messages.map((message) => JSON.stringify(message)).join('\n') + '\n'
    : '';
  fs.writeFileSync(filePath, payload, 'utf-8');
}

function nextSeq(messages: MailboxMessage[]): number {
  let maxSeq = 0;
  for (const message of messages) {
    if (message.seq > maxSeq) maxSeq = message.seq;
  }
  return maxSeq + 1;
}

function appendLocalNotification(options: {
  targetAgent: string;
  message: string;
  title: string;
  priority: string;
  sender: string;
  source: string;
  channel?: string;
  sessionId?: string;
  progressDelivery?: ProgressDeliveryPolicy;
}): {
  success: true;
  targetAgentId: string;
  messageId: string;
  seq: number;
  summary: string;
  nextAction: string;
  source: string;
  title: string;
  message: string;
} {
  const targetAgentId = options.targetAgent.trim();
  return withFileMutexSync(mailboxLockPath(targetAgentId), () => {
    const priority = resolveMailboxNotifyPriority(options.priority);
    const envelope = buildUserNotificationEnvelope(options.title, options.message, priority);
    const filePath = mailboxPath(targetAgentId);
    const messages = readMessagesFromPath(filePath);
    const seq = nextSeq(messages);
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const mailboxMessage: MailboxMessage = {
      id,
      seq,
      target: targetAgentId,
      content: {
        type: 'external-notification',
        source: options.source,
        title: options.title,
        message: options.message,
        envelopeId: envelope.id,
        envelope,
        ...(options.progressDelivery ? { progressDelivery: options.progressDelivery } : {}),
      },
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      sender: options.sender,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.channel ? { channel: options.channel } : {}),
      sourceType: 'observe',
      category: 'notification',
      priority: mapPriorityToMailboxLevel(priority),
      deliveryPolicy: 'realtime',
    };

    messages.push(mailboxMessage);
    writeMessagesToPath(filePath, messages);

    return {
      success: true,
      targetAgentId,
      messageId: id,
      seq,
      summary: `${options.title} -> ${targetAgentId}`,
      nextAction: 'Use normal queue/injection path to wake the agent if immediate handling is required.',
      source: options.source,
      title: options.title,
      message: options.message,
    };
  });
}

function listLocalMessages(options: { target?: string; status?: string; limit?: number }): MailboxMessage[] {
  const targets = options.target?.trim()
    ? [options.target.trim()]
    : listMailboxTargets();
  if (targets.length === 0) return [];

  const all: MailboxMessage[] = [];
  for (const target of targets) {
    const messages = readMessagesFromPath(mailboxPath(target));
    for (const message of messages) {
      if (options.status && message.status !== options.status) continue;
      all.push(message);
    }
  }

  all.sort((a, b) => {
    const aPriority = typeof a.priority === 'number' ? a.priority : 2;
    const bPriority = typeof b.priority === 'number' ? b.priority : 2;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return b.seq - a.seq;
  });

  if (typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0) {
    return all.slice(0, Math.floor(options.limit));
  }
  return all;
}

function getLocalMessageById(id: string): MailboxMessage | null {
  const targets = listMailboxTargets();
  for (const target of targets) {
    const found = readMessagesFromPath(mailboxPath(target)).find((message) => message.id === id);
    if (found) return found;
  }
  return null;
}

function clearLocalCompletedMessages(): number {
  const targets = listMailboxTargets();
  let removed = 0;
  for (const target of targets) {
    const removedForTarget = withFileMutexSync(mailboxLockPath(target), () => {
      const filePath = mailboxPath(target);
      const messages = readMessagesFromPath(filePath);
      const remaining = messages.filter((message) => message.status !== 'completed' && message.status !== 'failed');
      const delta = messages.length - remaining.length;
      if (delta > 0) {
        writeMessagesToPath(filePath, remaining);
      }
      return delta;
    });
    removed += removedForTarget;
  }
  return removed;
}

async function wakeAgent(options: {
  targetAgent: string;
  source: string;
  messageId: string;
  title?: string;
  message?: string;
  progressDelivery?: ProgressDeliveryPolicy;
}): Promise<Record<string, unknown>> {
  const source = options.source?.trim() || 'mailbox-cli';
  const title = options.title?.trim() || '';
  const originalMessage = options.message?.trim() || '';
  const digestPathMatch = originalMessage.match(/(\/[^\s]+digest_[^\s]+\.json)/);
  const digestPath = digestPathMatch?.[1] || '';
  const runtimeState = await fetchAgentBusyState(MAILBOX_BASE_URL, options.targetAgent);
  if (runtimeState.busy === true) {
    return {
      skipped: true,
      deferred: true,
      reason: 'target_busy',
      targetAgent: options.targetAgent,
      ...(runtimeState.status ? { targetStatus: runtimeState.status } : {}),
      nextAction: 'Mailbox message preserved; target is busy so immediate wake was skipped.',
    };
  }

  const lines = [
    `Mailbox notification arrived (messageId=${options.messageId}).`,
    'Please check mailbox and handle pending notification(s).',
    `Source=${source}${title ? `, title=${title}` : ''}.`,
  ];

  if (source === 'news-cron') {
    lines.push(
      '',
      '[NEWS-DELIVERY-CONTRACT]',
      '1) 完成处理后，必须直接向用户发送新闻正文（禁止仅回执“已处理/已保存文件”）。',
      '2) 输出格式：每条新闻两行（第一行中文标题，第二行原文 URL），条目之间空一行。',
      '3) 禁止标题行、禁止 emoji、禁止加粗、禁止列表符号（不能有“📰/**/-/1.”等前缀）。',
      '4) 至少输出 10 条（不足则输出全部）。',
      '5) 若 messageId 对应消息不存在，必须回退处理 mailbox 中所有 pending news-cron 通知，而不是直接结束。',
      digestPath ? `6) 数据文件：${digestPath}` : '',
    );
  }

  const wakeText = lines.filter((line) => line.length > 0).join('\n');
  const wakeRes = await fetch(`${MAILBOX_BASE_URL}/api/v1/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-finger-channel': 'system' },
    body: JSON.stringify({
      target: options.targetAgent,
      message: {
        text: wakeText,
        metadata: {
          role: 'system',
          source: options.source || 'mailbox-cli',
          ...(options.progressDelivery ? { progressDelivery: options.progressDelivery } : {}),
        },
      },
      blocking: false,
    }),
  });

  const wakeData = await wakeRes.json() as { error?: unknown } & Record<string, unknown>;
  if (!wakeRes.ok) {
    throw new Error(
      typeof wakeData.error === 'string'
        ? wakeData.error
        : `wake dispatch failed with status ${wakeRes.status}`,
    );
  }
  return wakeData;
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
    .option('--progress-mode <mode>', 'Progress delivery mode: all|result_only|silent')
    .option('--progress-fields <csv>', 'Comma-separated fields: reasoning,body,status,tool,step,progress')
    .option('--wake', 'After writing mailbox, send a direct wake message to target agent', false)
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
      progressMode?: string;
      progressFields?: string;
      wake: boolean;
    }) => {
      try {
        const progressDelivery = parseProgressDeliveryOptions(options)
          ?? defaultProgressDeliveryForSource(options.source);
        const notifyData = appendLocalNotification({
          ...options,
          ...(progressDelivery ? { progressDelivery } : {}),
        });

        let wakeResult: Record<string, unknown> | null = null;
        let wakeError: string | null = null;
        if (options.wake) {
          try {
            wakeResult = await wakeAgent({
              targetAgent: options.targetAgent,
              source: notifyData.source || options.source || 'mailbox-cli',
              messageId: notifyData.messageId,
              title: notifyData.title || options.title,
              message: notifyData.message || options.message,
              ...(progressDelivery ? { progressDelivery } : {}),
            });
          } catch (error) {
            wakeError = error instanceof Error ? error.message : String(error);
          }
        }

        clog.log(JSON.stringify({
          success: true,
          mailbox: notifyData,
          ...(wakeResult ? { wake: wakeResult } : {}),
          ...(wakeError ? { wakeDeferred: true, wakeError } : {}),
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
        const limit = Number.parseInt(options.limit, 10);
        const messages = listLocalMessages({
          target: options.target,
          status: options.status,
          limit: Number.isFinite(limit) ? limit : 10,
        });

        clog.log('\nMailbox Messages:');
        clog.log('-'.repeat(60));
        for (const msg of messages) {
          clog.log(`[${msg.id}] ${renderStatus(msg.status)} ${msg.target}`);
          clog.log(`  Created: ${new Date(msg.createdAt).toLocaleString()}`);
          if (msg.error) {
            clog.log(`  Error: ${msg.error}`);
          }
          clog.log('');
        }
        process.exit(0);
      } catch (err) {
        clog.error('Failed to list messages:', err);
        process.exit(1);
      }
    });

  mailbox
    .command('get <id>')
    .description('Get message details')
    .action(async (id: string) => {
      try {
        const data = getLocalMessageById(id);
        if (!data) {
          clog.error(`Message ${id} not found`);
          return;
        }

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
        process.exit(0);
      } catch (err) {
        clog.error('Failed to get message:', err);
        process.exit(1);
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
          const data = getLocalMessageById(id);
          if (!data) {
            spinner.fail(`Message ${id} not found`);
            return;
          }

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

          await new Promise((resolve) => setTimeout(resolve, 1000));
          await checkStatus();
        } catch (err) {
          spinner.fail(String(err));
        }
      };

      await checkStatus();
      process.exit(0);
    });

  mailbox
    .command('doctor')
    .description('Audit mailbox targets and optionally fix polluted/empty test namespaces')
    .option('--fix', 'Apply fix actions (quarantine test namespaces + prune empty unknown targets)')
    .option('--no-backup', 'Skip snapshot backup before fix')
    .action(async (options: { fix?: boolean; backup?: boolean }) => {
      try {
        const report = scanMailboxDoctor();
        if (!options.fix) {
          const topUnknown = report.entries
            .filter((entry) => !entry.knownTarget)
            .map((entry) => ({
              target: entry.target,
              inboxBytes: entry.inboxBytes,
              testNamespace: entry.testNamespace,
            }))
            .slice(0, 50);

          clog.log(JSON.stringify({
            success: true,
            mode: 'scan',
            mailboxRoot: report.mailboxRoot,
            summary: report.summary,
            unknownTargetsSample: topUnknown,
            hint: 'Re-run with --fix to quarantine test namespaces and prune empty unknown targets.',
          }, null, 2));
          process.exit(0);
          return;
        }

        const fixed = applyMailboxDoctorFix(report, {
          backup: options.backup !== false,
        });

        const after = scanMailboxDoctor();
        clog.log(JSON.stringify({
          success: true,
          mode: 'fix',
          mailboxRoot: report.mailboxRoot,
          before: report.summary,
          after: after.summary,
          backupPath: fixed.backupPath,
          quarantinePath: fixed.quarantinePath,
          movedTargets: fixed.movedTargets,
          prunedTargets: fixed.prunedTargets,
        }, null, 2));
        process.exit(0);
      } catch (err) {
        clog.error('Failed to run mailbox doctor:', err);
        process.exit(1);
      }
    });

  mailbox
    .command('clear')
    .description('Clear completed messages from mailbox')
    .action(async () => {
      try {
        const removed = clearLocalCompletedMessages();
        clog.log(`Mailbox cleaned up (${removed} removed)`);
        process.exit(0);
      } catch (err) {
        clog.error('Failed to clear mailbox:', err);
        process.exit(1);
      }
    });
}
