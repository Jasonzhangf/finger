import { describe, it, expect } from 'vitest';
import { extractChannelAttachmentsFromContext } from '../../../src/blocks/openclaw-plugin-manager/openclaw-api-adapter.js';

describe('extractChannelAttachmentsFromContext', () => {
  it('extracts image attachments from MediaPaths/MediaTypes arrays', () => {
    const attachments = extractChannelAttachmentsFromContext({
      MediaPaths: ['/tmp/a.png', '/tmp/b.jpg'],
      MediaTypes: ['image/png', 'image/jpeg'],
    });

    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({
      type: 'image',
      url: '/tmp/a.png',
      filename: 'a.png',
      mimeType: 'image/png',
      source: 'openclaw',
    });
    expect(attachments[1]).toMatchObject({
      type: 'image',
      url: '/tmp/b.jpg',
      filename: 'b.jpg',
      mimeType: 'image/jpeg',
      source: 'openclaw',
    });
  });

  it('supports single MediaPath/MediaType fields', () => {
    const attachments = extractChannelAttachmentsFromContext({
      MediaPath: '/tmp/c.webp',
      MediaType: 'image/webp',
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      type: 'image',
      url: '/tmp/c.webp',
      filename: 'c.webp',
      mimeType: 'image/webp',
    });
  });
});
