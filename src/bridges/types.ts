/**
 * Channel Bridge Types - 标准化渠道桥接接口
 */

export interface ChannelMessage {
  id: string;
  channelId: string;
  accountId: string;
  type: 'direct' | 'group' | 'channel';
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: number;
  threadId?: string;
  replyTo?: string;
  attachments?: ChannelAttachment[];
  metadata?: Record<string, unknown>;
}

export interface ChannelAttachment {
  type: 'image' | 'audio' | 'video' | 'file';
  url: string;
  filename?: string;
  size?: number;
}

export interface SendMessageOptions {
  to: string;
  text: string;
  replyTo?: string;
  attachments?: ChannelAttachment[];
}

export interface ChannelBridge {
  readonly id: string;
  readonly channelId: string;
  
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  
  sendMessage(options: SendMessageOptions): Promise<{ messageId: string }>;
}

export interface ChannelBridgeConfig {
  id: string;
  channelId: string;
  enabled: boolean;
  credentials: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface ChannelBridgeCallbacks {
  onMessage: (msg: ChannelMessage) => Promise<void>;
  onError: (err: Error) => void;
  onReady: () => void;
  onClose: () => void;
}
