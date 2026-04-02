import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  extractHttpUrls,
  triggerChannelLinkAutoDetail,
} from '../../../src/server/modules/channel-link-auto-detail.js';
import type { FingerConfig } from '../../../src/core/config/channel-config.js';

function createBaseConfig(): FingerConfig {
  return {
    channelAutoDetail: {
      enabled: true,
      channels: ['qqbot'],
      webautoBin: 'webauto',
      webautoWorkdir: '~/github/webauto',
      submitTimeoutMs: 10_000,
      outputRoot: '/tmp/webauto-download',
      weibo: {
        enabled: true,
        profile: 'weibo',
        env: 'prod',
        maxPosts: 1,
      },
      xiaohongshu: {
        enabled: true,
        profile: 'xhs-qa-1',
        env: 'debug',
        maxNotes: 1,
      },
    },
  };
}

describe('channel-link-auto-detail', () => {
  it('extracts and deduplicates http links from text', () => {
    const urls = extractHttpUrls([
      '看看这个 https://weibo.com/123/Abc',
      '还有这个 https://www.xiaohongshu.com/explore/67e493de000000001d0177d2',
      '重复 https://weibo.com/123/Abc',
    ].join('\n'));
    expect(urls).toEqual([
      'https://weibo.com/123/Abc',
      'https://www.xiaohongshu.com/explore/67e493de000000001d0177d2',
    ]);
  });

  it('submits weibo/xhs detail jobs for supported links with configurable output root', async () => {
    const runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'finger-auto-detail-'));
    const runCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
      durationMs: 15,
    });

    const jobs = await triggerChannelLinkAutoDetail(
      {
        channelId: 'qqbot',
        messageId: 'msg-123',
        content: [
          'A https://weibo.com/123/Abc',
          'B https://www.xiaohongshu.com/explore/67e493de000000001d0177d2',
        ].join('\n'),
        fingerConfig: createBaseConfig(),
      },
      {
        runtimeDir,
        runCommand,
      },
    );

    expect(jobs).toHaveLength(2);
    expect(runCommand).toHaveBeenCalledTimes(2);

    const weiboJob = jobs.find((j) => j.ruleId === 'legacy-weibo-detail');
    const xhsJob = jobs.find((j) => j.ruleId === 'legacy-xhs-detail');
    expect(weiboJob).toBeDefined();
    expect(xhsJob).toBeDefined();

    expect(weiboJob?.commandArray).toEqual(expect.arrayContaining([
      'weibo',
      'detail',
      '--output-root',
      '/tmp/webauto-download',
    ]));
    expect(xhsJob?.commandArray).toEqual(expect.arrayContaining([
      'xhs',
      'unified',
      '--stage',
      'detail',
      '--output-root',
      '/tmp/webauto-download',
    ]));

    const weiboLinksFile = weiboJob?.linksFilePath || '';
    const xhsLinksFile = xhsJob?.linksFilePath || '';
    expect(readFileSync(weiboLinksFile, 'utf8')).toContain('"url":"https://weibo.com/123/Abc"');
    expect(readFileSync(xhsLinksFile, 'utf8')).toContain('"noteUrl":"https://www.xiaohongshu.com/explore/67e493de000000001d0177d2"');
  });

  it('supports trigger skeleton rules with configurable match/input/command', async () => {
    const runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'finger-auto-detail-'));
    const runCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 9,
    });
    const cfg: FingerConfig = {
      channelAutoDetail: {
        enabled: true,
        channels: ['qqbot'],
        triggers: [
          {
            id: 'custom-weibo-rule',
            enabled: true,
            match: {
              urlHosts: ['weibo.com'],
            },
            input: {
              format: 'jsonl',
              rowTemplate: '{"url":"${url}","channel":"${channel_id}","idx":"${index}"}',
            },
            output: {
              outputRoot: '/tmp/custom-output-root',
            },
            command: {
              bin: 'webauto',
              cwd: '~/github/webauto',
              timeoutMs: 3000,
              args: [
                'daemon',
                'task',
                'submit',
                '--detach',
                '--',
                'weibo',
                'detail',
                '--links-file',
                '${links_file}',
                '--max-posts',
                '${links_count}',
                '--output-root',
                '${output_root}',
              ],
            },
          },
        ],
      },
    };
    const jobs = await triggerChannelLinkAutoDetail(
      {
        channelId: 'qqbot',
        messageId: 'msg-xyz',
        content: [
          'weibo: https://weibo.com/123/Abc',
          'xhs: https://www.xiaohongshu.com/explore/67e493de000000001d0177d2',
        ].join('\n'),
        fingerConfig: cfg,
      },
      { runtimeDir, runCommand },
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.ruleId).toBe('custom-weibo-rule');
    expect(jobs[0]?.commandArray).toEqual(expect.arrayContaining([
      'weibo',
      'detail',
      '--max-posts',
      '1',
      '--output-root',
      '/tmp/custom-output-root',
    ]));
    const linksContent = readFileSync(jobs[0]?.linksFilePath || '', 'utf8');
    expect(linksContent).toContain('"channel":"qqbot"');
    expect(linksContent).toContain('"url":"https://weibo.com/123/Abc"');
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('does not submit when channel is not enabled in config', async () => {
    const runCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 10,
    });
    const jobs = await triggerChannelLinkAutoDetail(
      {
        channelId: 'weixin',
        content: 'https://weibo.com/123/Abc',
        fingerConfig: createBaseConfig(),
      },
      { runCommand, runtimeDir: mkdtempSync(path.join(os.tmpdir(), 'finger-auto-detail-')) },
    );
    expect(jobs).toHaveLength(0);
    expect(runCommand).not.toHaveBeenCalled();
  });
});
