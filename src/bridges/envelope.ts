/**
 * Channel Bridge Envelope - 统一消息封套
 *
 * 定义所有通道消息的统一封套格式，确保：
 * - 消息 ID 唯一且可追溯（使用原始通道 ID）
 * - replyTo 正确传递（使用 metadata.messageId）
 * - metadata 包含所有通道特定信息
 */

import type { ChannelMessage } from './types.js';
import type { MessageHub } from '../orchestration/message-hub.js';

/**
 * 通道消息封套 - MessageHub 统一格式
 */
export interface ChannelBridgeEnvelope {
  /** 唯一消息 ID（优先使用原始通道消息 ID） */
  id: string;
  /** 通道 ID */
  channelId: string;
  /** 账户 ID */
  accountId: string;
  /** 消息类型 */
  type: 'direct' | 'group' | 'channel';
  /** 发送者 ID */
  senderId: string;
  /** 发送者名称（可选） */
  senderName?: string;
  /** 消息内容 */
  content: string;
  /** 时间戳 */
  timestamp: number;
  /** 元数据（包含原始通道消息 ID） */
  metadata: {
    /** 原始通道消息 ID（用于 replyTo） */
    messageId: string;
    /** 对方 ID */
    peerId?: string;
    /** 群/频道 ID */
    groupId?: string;
    /** 其他通道特定信息 */
    [key: string]: unknown;
  };
}

/**
 * 从 ChannelMessage 转换为 Envelope
 */
export function toEnvelope(message: ChannelMessage): ChannelBridgeEnvelope {
  // 确保 messageId 存在
  const originalMessageId = message.metadata?.messageId as string;
  const envelope: ChannelBridgeEnvelope = {
    // 使用原始消息 ID，fallback 到自生成 ID
    id: originalMessageId || message.id,
    channelId: message.channelId,
    accountId: message.accountId,
    type: message.type,
    senderId: message.senderId,
    senderName: message.senderName,
    content: message.content,
    timestamp: message.timestamp,
    metadata: {
      // 始终保留原始消息 ID
      messageId: originalMessageId,
      // 复制所有其他 metadata
      ...(message.metadata as Record<string, unknown>),
    },
  };
  return envelope;
}

/**
 * 从 Envelope 提取 replyTo ID
 */
export function extractReplyTo(envelope: ChannelBridgeEnvelope): string {
  return envelope.metadata.messageId || envelope.id;
}

/**
 * 创建发送选项（用于 sendMessage）
 */
export function createSendOptions(
  envelope: ChannelBridgeEnvelope,
  replyContent: string
): { to: string; text: string; replyTo?: string } {
  const target = envelope.type === 'group' && envelope.metadata.groupId
    ? `group:${envelope.metadata.groupId}`
    : envelope.senderId;

  return {
    to: target,
    text: replyContent,
    replyTo: extractReplyTo(envelope),
  };
}

/**
 * Envelope 验证断言（用于测试）
 */
export interface EnvelopeAssertions {
  /** messageId 必须等于原始消息 ID */
  messageIdIsOriginal: boolean;
  /** id 必须使用原始消息 ID */
  idUsesOriginal: boolean;
  /** metadata.messageId 必须存在 */
  hasMetadataMessageId: boolean;
  /** replyTo 必须等于 metadata.messageId */
  replyToMatchesMetadata: boolean;
}

/**
 * 验证 Envelope 断言
 */
export function validateEnvelope(envelope: ChannelBridgeEnvelope): EnvelopeAssertions {
  const replyTo = extractReplyTo(envelope);
  return {
    messageIdIsOriginal: !!envelope.metadata.messageId,
    idUsesOriginal: envelope.id === envelope.metadata.messageId,
    hasMetadataMessageId: !!envelope.metadata.messageId,
    replyToMatchesMetadata: replyTo === envelope.metadata.messageId,
  };
}

/**
 * 断言 Envelope 符合规范（用于测试）
 */
export function assertEnvelopeValid(envelope: ChannelBridgeEnvelope): void {
  const validation = validateEnvelope(envelope);

  if (!validation.messageIdIsOriginal) {
    throw new Error('Envelope missing original messageId in metadata');
  }

  if (!validation.idUsesOriginal) {
    throw new Error('Envelope id should use original messageId');
  }

  if (!validation.hasMetadataMessageId) {
    throw new Error('Envelope missing metadata.messageId');
  }

  if (!validation.replyToMatchesMetadata) {
    throw new Error('Envelope replyTo should match metadata.messageId');
  }
}
