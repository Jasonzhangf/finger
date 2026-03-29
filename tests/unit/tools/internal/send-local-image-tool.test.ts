import { describe, expect, it } from 'vitest';
import { __sendLocalImageInternals } from '../../../../src/tools/internal/send-local-image-tool.js';

describe('send_local_image tool', () => {
  it('uses plain local path for qqbot channel', () => {
    const resolvedPath = '/tmp/weibo_qr.png';
    const url = __sendLocalImageInternals.resolveAttachmentUrlForChannel('qqbot', resolvedPath);
    expect(url).toBe(resolvedPath);
  });

  it('uses file URL for non-qqbot channels', () => {
    const resolvedPath = '/tmp/weibo_qr.png';
    const url = __sendLocalImageInternals.resolveAttachmentUrlForChannel('openclaw-weixin', resolvedPath);
    expect(url.startsWith('file://')).toBe(true);
  });
});

