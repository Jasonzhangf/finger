import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../../core/logger.js';
import { FINGER_PATHS, ensureDir } from '../../core/finger-paths.js';
import {
  type ChannelAutoDetailConfig,
  type ChannelAutoDetailTriggerRule,
  type FingerConfig,
  resolveHomePath,
} from '../../core/config/channel-config.js';
import {
  runSpawnCommand,
  type SpawnRunnerInput,
  type SpawnRunnerOutput,
} from '../../tools/internal/spawn-runner.js';

const log = logger.module('ChannelLinkAutoDetail');

export interface AutoDetailSubmitJob {
  ruleId: string;
  links: string[];
  linksFilePath: string;
  commandArray: string[];
  cwd: string;
  timeoutMs: number;
}

interface TriggerParams {
  channelId: string;
  messageId?: string;
  content: string;
  fingerConfig: FingerConfig;
}

interface TriggerDeps {
  runCommand?: (input: SpawnRunnerInput) => Promise<SpawnRunnerOutput>;
  runtimeDir?: string;
}

interface TemplateContext {
  channel_id: string;
  message_id: string;
  links_count: string;
  links_file: string;
  output_root: string;
  url?: string;
  note_id?: string;
  index?: string;
}

function normalizeUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function getUrlHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function safeRuleId(input: string): string {
  const normalized = String(input || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
  return normalized.length > 0 ? normalized : 'auto-trigger';
}

function asPositiveInt(input: unknown, fallback: number): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function extractXhsNoteId(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const parts = parsed.pathname.split('/').map((item) => item.trim()).filter(Boolean);
    const idxExplore = parts.findIndex((p) => p === 'explore');
    if (idxExplore >= 0 && parts[idxExplore + 1]) return parts[idxExplore + 1];
    const idxItem = parts.findIndex((p) => p === 'item');
    if (idxItem >= 0 && parts[idxItem + 1]) return parts[idxItem + 1];
    return null;
  } catch {
    return null;
  }
}

function buildGlobalOutputRoot(config: ChannelAutoDetailConfig | undefined): string {
  const root = typeof config?.outputRoot === 'string' ? config.outputRoot.trim() : '';
  return root ? resolveHomePath(root) : '';
}

function resolveRuleOutputRoot(rule: ChannelAutoDetailTriggerRule, config: ChannelAutoDetailConfig | undefined): string {
  const ruleRoot = typeof rule.output?.outputRoot === 'string' ? rule.output.outputRoot.trim() : '';
  if (ruleRoot) return resolveHomePath(ruleRoot);
  return buildGlobalOutputRoot(config);
}

function resolveOutputRoot(config: ChannelAutoDetailConfig | undefined, platform: 'weibo' | 'xiaohongshu'): string {
  const perPlatform = platform === 'weibo'
    ? (typeof config?.weibo?.outputRoot === 'string' ? config.weibo.outputRoot.trim() : '')
    : (typeof config?.xiaohongshu?.outputRoot === 'string' ? config.xiaohongshu.outputRoot.trim() : '');
  if (perPlatform) return resolveHomePath(perPlatform);
  return buildGlobalOutputRoot(config);
}

function renderTemplate(template: string, context: TemplateContext): string {
  return template.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = context[key as keyof TemplateContext];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function extractHttpUrls(input: string): string[] {
  if (!input || typeof input !== 'string') return [];
  const regex = /https?:\/\/[^\s<>"'`，。！？；：）】】]+/gi;
  const seen = new Set<string>();
  const urls: string[] = [];
  const matches = input.match(regex) ?? [];
  for (const item of matches) {
    const normalized = normalizeUrl(item.trim());
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return urls;
}

function channelEnabled(config: ChannelAutoDetailConfig | undefined, channelId: string): boolean {
  if (!config || config.enabled !== true) return false;
  const allowed = Array.isArray(config.channels)
    ? config.channels.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (allowed.length === 0) return true;
  const channel = channelId.trim().toLowerCase();
  return allowed.includes('*') || allowed.includes(channel);
}

function channelAllowedByRule(channelId: string, ruleChannels: string[] | undefined, fallbackChannels: string[] | undefined): boolean {
  const fromRule = Array.isArray(ruleChannels)
    ? ruleChannels.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const source = fromRule.length > 0
    ? fromRule
    : (Array.isArray(fallbackChannels)
      ? fallbackChannels.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
      : []);
  if (source.length === 0) return true;
  const normalized = channelId.trim().toLowerCase();
  return source.includes('*') || source.includes(normalized);
}

function hostMatches(host: string, candidate: string): boolean {
  const normalized = candidate.trim().toLowerCase();
  if (!normalized) return false;
  return host === normalized || host.endsWith(`.${normalized}`);
}

function selectMatchedUrlsByRule(rule: ChannelAutoDetailTriggerRule, allUrls: string[], content: string): string[] {
  const match = rule.match;
  if (!match) return allUrls.slice();

  const containsAny = Array.isArray(match.containsAny)
    ? match.containsAny.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (containsAny.length > 0) {
    const lower = content.toLowerCase();
    const textMatched = containsAny.some((token) => lower.includes(token));
    if (!textMatched) return [];
  }

  const hostRules = Array.isArray(match.urlHosts)
    ? match.urlHosts.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const hostRegexRules = Array.isArray(match.urlHostRegex)
    ? match.urlHostRegex.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (hostRules.length === 0 && hostRegexRules.length === 0) return allUrls.slice();

  const regexes = hostRegexRules
    .map((pattern) => {
      try {
        return new RegExp(pattern, 'i');
      } catch {
        log.warn('Invalid channel auto-detail urlHostRegex, ignored', { ruleId: rule.id, pattern });
        return null;
      }
    })
    .filter((item): item is RegExp => Boolean(item));

  const matched: string[] = [];
  for (const url of allUrls) {
    const host = getUrlHost(url);
    if (!host) continue;
    const byHost = hostRules.some((candidate) => hostMatches(host, candidate));
    const byRegex = regexes.some((rx) => rx.test(host));
    if (byHost || byRegex) matched.push(url);
  }
  return matched;
}

function getLegacyRuleSet(config: ChannelAutoDetailConfig): ChannelAutoDetailTriggerRule[] {
  const webautoBin = typeof config.webautoBin === 'string' && config.webautoBin.trim().length > 0
    ? config.webautoBin.trim()
    : 'webauto';
  const workdir = typeof config.webautoWorkdir === 'string' && config.webautoWorkdir.trim().length > 0
    ? resolveHomePath(config.webautoWorkdir.trim())
    : resolveHomePath('~/github/webauto');
  const timeoutMs = asPositiveInt(config.submitTimeoutMs, 15_000);
  const globalChannels = Array.isArray(config.channels) ? config.channels : ['qqbot', 'openclaw-weixin'];

  const rules: ChannelAutoDetailTriggerRule[] = [];

  if (config.weibo?.enabled !== false) {
    const profile = String(config.weibo?.profile || '').trim();
    if (profile.length > 0) {
      const outputRoot = resolveOutputRoot(config, 'weibo');
      const env = String(config.weibo?.env || 'prod').trim() || 'prod';
      const maxPosts = String(asPositiveInt(config.weibo?.maxPosts, 1));
      const keyword = String(config.weibo?.keyword || 'channel-link').trim() || 'channel-link';
      rules.push({
        id: 'legacy-weibo-detail',
        enabled: true,
        channels: globalChannels,
        match: {
          urlHosts: ['weibo.com', 'weibo.cn'],
        },
        input: {
          format: 'jsonl',
          fileNamePrefix: 'weibo',
          rowTemplate: '{"id":"${message_id}-${index}","url":"${url}"}',
        },
        command: {
          bin: webautoBin,
          cwd: workdir,
          timeoutMs,
          args: [
            'daemon',
            'task',
            'submit',
            '--detach',
            '--',
            'weibo',
            'detail',
            '--profile',
            profile,
            '--links-file',
            '${links_file}',
            '--max-posts',
            maxPosts,
            '--env',
            env,
            '--keyword',
            keyword,
            ...(outputRoot ? ['--output-root', outputRoot] : []),
          ],
        },
      });
    }
  }

  if (config.xiaohongshu?.enabled !== false) {
    const profile = String(config.xiaohongshu?.profile || '').trim();
    if (profile.length > 0) {
      const outputRoot = resolveOutputRoot(config, 'xiaohongshu');
      const env = String(config.xiaohongshu?.env || 'prod').trim() || 'prod';
      const maxNotes = String(asPositiveInt(config.xiaohongshu?.maxNotes, 1));
      rules.push({
        id: 'legacy-xhs-detail',
        enabled: true,
        channels: globalChannels,
        match: {
          urlHosts: ['xiaohongshu.com', 'xhslink.com'],
        },
        input: {
          format: 'jsonl',
          fileNamePrefix: 'xhs',
          rowTemplate: '{"noteId":"${note_id}","noteUrl":"${url}","url":"${url}","source":"finger-channel-link-auto-detail"}',
        },
        command: {
          bin: webautoBin,
          cwd: workdir,
          timeoutMs,
          args: [
            'daemon',
            'task',
            'submit',
            '--detach',
            '--',
            'xhs',
            'unified',
            '--profile',
            profile,
            '--stage',
            'detail',
            '--shared-harvest-path',
            '${links_file}',
            '--max-notes',
            maxNotes,
            '--env',
            env,
            ...(outputRoot ? ['--output-root', outputRoot] : []),
          ],
        },
      });
    }
  }
  return rules;
}

function resolveTriggerRules(config: ChannelAutoDetailConfig): ChannelAutoDetailTriggerRule[] {
  const explicit = Array.isArray(config.triggers)
    ? config.triggers.filter((item): item is ChannelAutoDetailTriggerRule => Boolean(item && typeof item === 'object' && typeof item.id === 'string'))
    : [];
  if (explicit.length > 0) return explicit;
  return getLegacyRuleSet(config);
}

async function writeLinksFile(params: {
  runtimeRoot: string;
  ruleId: string;
  messageId?: string;
  fileNamePrefix: string;
  lines: string[];
}): Promise<string> {
  const baseDir = path.join(params.runtimeRoot, 'channel-link-auto-detail', safeRuleId(params.ruleId));
  ensureDir(baseDir);
  const safeMessageId = (params.messageId || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'msg';
  const prefix = safeRuleId(params.fileNamePrefix || params.ruleId);
  const filePath = path.join(baseDir, `${Date.now()}-${prefix}-${safeMessageId}.jsonl`);
  await fs.writeFile(filePath, `${params.lines.join('\n')}\n`, 'utf8');
  return filePath;
}

function buildJsonlLines(rule: ChannelAutoDetailTriggerRule, urls: string[], baseContext: TemplateContext): string[] {
  const template = String(rule.input?.rowTemplate || '{"url":"${url}"}').trim() || '{"url":"${url}"}';
  return urls.map((url, idx) => {
    const context: TemplateContext = {
      ...baseContext,
      url,
      index: String(idx + 1),
      note_id: extractXhsNoteId(url) || `${baseContext.message_id}-${idx + 1}`,
    };
    return renderTemplate(template, context);
  });
}

function buildCommand(rule: ChannelAutoDetailTriggerRule, context: TemplateContext): {
  commandArray: string[];
  cwd: string;
  timeoutMs: number;
} | null {
  const args = Array.isArray(rule.command?.args) ? rule.command.args : [];
  if (args.length === 0) return null;
  const bin = String(rule.command?.bin || '').trim() || 'webauto';
  const cwdRaw = String(rule.command?.cwd || '~/github/webauto').trim() || '~/github/webauto';
  const cwd = resolveHomePath(cwdRaw);
  const timeoutMs = asPositiveInt(rule.command?.timeoutMs, 15_000);
  const commandArray = [bin, ...args.map((item) => renderTemplate(String(item), context))];
  return { commandArray, cwd, timeoutMs };
}

export async function triggerChannelLinkAutoDetail(
  params: TriggerParams,
  deps: TriggerDeps = {},
): Promise<AutoDetailSubmitJob[]> {
  const autoDetail = params.fingerConfig.channelAutoDetail;
  if (!channelEnabled(autoDetail, params.channelId)) return [];

  const allUrls = extractHttpUrls(params.content);
  if (allUrls.length === 0) return [];
  const runtimeRoot = deps.runtimeDir || FINGER_PATHS.runtime.dir;
  const runCommand = deps.runCommand ?? runSpawnCommand;
  const messageId = String(params.messageId || 'msg').trim() || 'msg';

  const rules = autoDetail ? resolveTriggerRules(autoDetail) : [];
  if (rules.length === 0) return [];

  const jobs: AutoDetailSubmitJob[] = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (!channelAllowedByRule(params.channelId, rule.channels, autoDetail?.channels)) continue;
    const matchedUrls = selectMatchedUrlsByRule(rule, allUrls, params.content);
    if (matchedUrls.length === 0) continue;

    const baseContext: TemplateContext = {
      channel_id: params.channelId,
      message_id: messageId,
      links_count: String(matchedUrls.length),
      links_file: '',
      output_root: resolveRuleOutputRoot(rule, autoDetail),
    };
    const lines = buildJsonlLines(rule, matchedUrls, baseContext);
    const linksFilePath = await writeLinksFile({
      runtimeRoot,
      ruleId: rule.id,
      messageId,
      fileNamePrefix: String(rule.input?.fileNamePrefix || rule.id),
      lines,
    });
    const commandContext: TemplateContext = {
      ...baseContext,
      links_file: linksFilePath,
    };
    const submit = buildCommand(rule, commandContext);
    if (!submit) {
      log.warn('Auto-detail submit skipped due to invalid command config', {
        ruleId: rule.id,
        channelId: params.channelId,
        messageId: params.messageId,
      });
      continue;
    }
    jobs.push({
      ruleId: rule.id,
      links: matchedUrls,
      linksFilePath,
      commandArray: submit.commandArray,
      cwd: submit.cwd,
      timeoutMs: submit.timeoutMs,
    });
  }

  for (const job of jobs) {
    void runCommand({
      commandArray: job.commandArray,
      cwd: job.cwd,
      timeoutMs: job.timeoutMs,
    }).then((result) => {
      if (result.exitCode !== 0 || result.timedOut) {
        log.warn('Auto-detail submit command failed', {
          ruleId: job.ruleId,
          channelId: params.channelId,
          messageId: params.messageId,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stderr: result.stderr.slice(0, 400),
        });
        return;
      }
      log.info('Auto-detail submit command accepted', {
        ruleId: job.ruleId,
        channelId: params.channelId,
        messageId: params.messageId,
        links: job.links.length,
        linksFilePath: job.linksFilePath,
      });
    }).catch((error) => {
      log.error('Auto-detail submit command error', error instanceof Error ? error : undefined, {
        ruleId: job.ruleId,
        channelId: params.channelId,
        messageId: params.messageId,
      });
    });
  }
  return jobs;
}
