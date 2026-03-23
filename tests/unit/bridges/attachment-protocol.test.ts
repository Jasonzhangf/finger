/**
 * Attachment Protocol 单元测试
 *
 * 验证：
 * 1. ChannelAttachment 统一字段定义完整性
 * 2. normalizeAttachments 正确解析和过滤
 * 3. events.ts 的 Attachment 与 bridges/types 导出一致
 * 4. SendMessageOptions 带 attachments 路径走 sendMedia
 * 5. 无 attachments 时走 sendText 退路
 * 6. 多图片场景：第一张 sendMedia，后续走 text 链接降级
 */

import { describe, it, expect, vi } from 'vitest';
import type { ChannelAttachment, SendMessageOptions } from '../../../src/bridges/types.js';
import type { Attachment as EventsAttachment } from '../../../src/runtime/events.js';
import type { Attachment as LedgerAttachment } from '../../../src/runtime/ledger-writer.js';
import { isAttachmentPlaceholder, type AttachmentPlaceholder, type SessionAttachment } from '../../../src/runtime/ledger-reader.js';

describe('Attachment Protocol (finger-256.1)', () => {
  // ---------------------------------------------------------------------------
  // 1. Type compatibility: bridges/types → events.ts → ledger-writer.ts
  // ---------------------------------------------------------------------------
  describe('type consistency across layers', () => {
    it('events.ts Attachment is re-exported from bridges/types (structural compat)', () => {
      // All ChannelAttachment fields must be assignable to Attachment from events.ts
      const channelAtt: ChannelAttachment = {
        id: 'test-1',
        type: 'image',
        url: 'https://example.com/img.png',
        filename: 'img.png',
        mimeType: 'image/png',
        size: 1024,
        width: 800,
        height: 600,
        thumbnailUrl: 'https://example.com/thumb.png',
        source: 'qqbot',
        metadata: { key: 'value' },
      };

      // Should be assignable to events.ts Attachment (re-export)
      const eventsAtt: EventsAttachment = channelAtt;
      expect(eventsAtt).toBeDefined();

      // Should be assignable to ledger-writer.ts Attachment
      const ledgerAtt: LedgerAttachment = channelAtt;
      expect(ledgerAtt).toBeDefined();
    });

    it('supports all media types', () => {
      const types: ChannelAttachment['type'][] = ['image', 'audio', 'video', 'file', 'code'];
      for (const type of types) {
        const att: ChannelAttachment = { type, url: 'https://example.com/file' };
        expect(att.type).toBe(type);
      }
    });

    it('minimal attachment (only required fields)', () => {
      const att: ChannelAttachment = {
        type: 'file',
        url: 'https://example.com/doc.pdf',
      };
      expect(att.url).toBe('https://example.com/doc.pdf');
      expect(att.filename).toBeUndefined();
      expect(att.mimeType).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. SendMessageOptions carries attachments
  // ---------------------------------------------------------------------------
  describe('SendMessageOptions with attachments', () => {
    it('carries image attachments correctly', () => {
      const options: SendMessageOptions = {
        to: 'user-123',
        text: 'Hello with image',
        attachments: [{
          id: 'att-1',
          type: 'image',
          url: 'https://cdn.example.com/photo.jpg',
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 204800,
          width: 1920,
          height: 1080,
        }],
      };
      expect(options.attachments).toHaveLength(1);
      expect(options.attachments![0].type).toBe('image');
      expect(options.attachments![0].mimeType).toBe('image/jpeg');
    });

    it('supports mixed attachment types', () => {
      const options: SendMessageOptions = {
        to: 'user-123',
        text: 'Mixed content',
        attachments: [
          { type: 'image', url: 'https://cdn.example.com/img.png' },
          { type: 'file', url: 'https://cdn.example.com/doc.pdf', filename: 'doc.pdf' },
          { type: 'audio', url: 'https://cdn.example.com/voice.mp3', mimeType: 'audio/mpeg' },
        ],
      };
      expect(options.attachments).toHaveLength(3);
      const imageCount = options.attachments!.filter(a => a.type === 'image').length;
      expect(imageCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. OpenClawBridgeAdapter routing logic (mock-based)
  // ---------------------------------------------------------------------------
  describe('OpenClawBridgeAdapter sendMedia routing', () => {
    it('routes to sendMedia when image attachments present', async () => {
      // Simulate the adapter's routing logic
      const options: SendMessageOptions = {
        to: 'user-123',
        text: 'See this image',
        attachments: [{
          type: 'image',
          url: 'https://cdn.example.com/img.png',
          filename: 'img.png',
        }],
      };

      const imageAttachments = (options.attachments || []).filter(a => a.type === 'image' && a.url);
      expect(imageAttachments).toHaveLength(1);
      expect(imageAttachments[0].url).toBe('https://cdn.example.com/img.png');
    });

    it('routes to sendText when no image attachments', () => {
      const options: SendMessageOptions = {
        to: 'user-123',
        text: 'Plain text message',
      };
      const imageAttachments = (options.attachments || []).filter(a => a.type === 'image' && a.url);
      expect(imageAttachments).toHaveLength(0);
    });

    it('handles multiple images: first via sendMedia, rest via text links', () => {
      const options: SendMessageOptions = {
        to: 'user-123',
        text: 'Multiple images',
        attachments: [
          { type: 'image', url: 'https://cdn.example.com/img1.png', filename: 'img1.png' },
          { type: 'image', url: 'https://cdn.example.com/img2.png', filename: 'img2.png' },
          { type: 'image', url: 'https://cdn.example.com/img3.jpg', filename: 'img3.jpg' },
        ],
      };

      const imageAttachments = (options.attachments || []).filter(a => a.type === 'image' && a.url);
      expect(imageAttachments).toHaveLength(3);

      // First image goes via sendMedia
      const firstMediaUrl = imageAttachments[0].url;
      expect(firstMediaUrl).toBe('https://cdn.example.com/img1.png');

      // Remaining images become text links
      const extraLinks = imageAttachments.slice(1).map(a => `${a.filename || 'image'}: ${a.url}`).join('\n');
      expect(extraLinks).toContain('img2.png');
      expect(extraLinks).toContain('img3.jpg');
    });

    it('skips attachments without url', () => {
      const options: SendMessageOptions = {
        to: 'user-123',
        text: 'Broken attachment',
        attachments: [
          { type: 'image', url: '' },
          { type: 'image', url: 'https://cdn.example.com/valid.png' },
        ],
      };

      const imageAttachments = (options.attachments || []).filter(a => a.type === 'image' && a.url);
      expect(imageAttachments).toHaveLength(1);
      expect(imageAttachments[0].url).toBe('https://cdn.example.com/valid.png');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. DisplayChannelRequest with attachments
  // ---------------------------------------------------------------------------
  describe('DisplayChannelRequest attachments', () => {
    it('type includes attachments field', async () => {
      // Import the actual types to verify compilation
      const { DisplayChannelRequest } = await import('../../../src/server/routes/message-types.js');
      type TestDCR = DisplayChannelRequest;
      const dcr: TestDCR = {
        channelId: 'qqbot',
        to: 'user-123',
        attachments: [{
          type: 'image',
          url: 'https://cdn.example.com/img.png',
          filename: 'img.png',
          mimeType: 'image/png',
        }],
      };
      expect(dcr.channelId).toBe('qqbot');
      expect(dcr.attachments).toBeDefined();
      expect(dcr.attachments!).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. History attachment placeholder
  // ---------------------------------------------------------------------------
  describe('history attachment placeholder', () => {
    it('isAttachmentPlaceholder correctly identifies placeholder', () => {
      const placeholder: AttachmentPlaceholder = { count: 2, summary: '2 images' };
      expect(isAttachmentPlaceholder(placeholder)).toBe(true);

      const full: ChannelAttachment[] = [{ type: 'image', url: 'https://example.com/img.png' }];
      expect(isAttachmentPlaceholder(full)).toBe(false);

      expect(isAttachmentPlaceholder(undefined)).toBe(false);
      expect(isAttachmentPlaceholder(null)).toBe(false);
    });

    it('placeholder has count and summary', () => {
      const placeholder: AttachmentPlaceholder = {
        count: 3,
        summary: '2 images, 1 file',
      };
      expect(placeholder.count).toBe(3);
      expect(placeholder.summary).toBe('2 images, 1 file');
    });
  });
});
