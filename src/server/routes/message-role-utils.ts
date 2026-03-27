/**
 * Message Role Utilities
 * Extracted from message.ts to keep file under 500-line limit.
 */

import { isObjectRecord } from '../common/object.js';

export function inferInboundRole(message: unknown, sender: string): 'user' | 'system' {
  const metadata = isObjectRecord(message) && isObjectRecord(message.metadata)
    ? message.metadata
    : null;

  if (metadata) {
    const explicitRole = typeof metadata.role === 'string' ? metadata.role.trim().toLowerCase() : '';
    if (explicitRole === 'system') return 'system';
    if (explicitRole === 'user') return 'user';

    if (metadata.systemDirectInject === true) return 'system';

    const source = typeof metadata.source === 'string' ? metadata.source.trim().toLowerCase() : '';
    if (
      source.startsWith('system-')
      || source === 'heartbeat'
      || source === 'scheduler'
      || source === 'clock'
      || source === 'timer'
    ) {
      return 'system';
    }
  }

  const normalizedSender = sender.trim().toLowerCase();
  if (
    normalizedSender === 'system'
    || normalizedSender.includes('heartbeat')
    || normalizedSender.includes('scheduler')
    || normalizedSender.includes('daemon')
    || normalizedSender.includes('timer')
  ) {
    return 'system';
  }

  return 'user';
}

export function ensureMessageMetadataRole(message: unknown, role: 'user' | 'system'): unknown {
  if (isObjectRecord(message)) {
    const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
    if (typeof metadata.role === 'string' && metadata.role.trim().length > 0) {
      return message;
    }
    return {
      ...message,
      metadata: {
        ...metadata,
        role,
      },
    };
  }

  if (typeof message === 'string') {
    return {
      text: message,
      content: message,
      metadata: { role },
    };
  }

  return message;
}
