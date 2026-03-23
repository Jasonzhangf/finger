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

/**
 * Channel type definition
 * Each channel type corresponds to an OpenClaw plugin (or built-in type).
 * The type determines how credentials are structured and how the bridge works.
 */
export type ChannelType = 'openclaw-plugin' | 'webui' | 'builtin';

/**
 * Push settings - controls what content is pushed to a channel.
 * All status update paths MUST check these settings before sending.
 */
export interface PushSettings {
  /** Push reasoning/thinking content (default: false) */
  reasoning: boolean;
  /** Push status updates (default: true) */
  statusUpdate: boolean;
  /** Push tool call details (default: false) */
  toolCalls: boolean;
  /** Push step updates in batches (default: true) */
  stepUpdates: boolean;
  /** Step batch size: push every N steps (default: 5) */
  stepBatch: number;
  /** Push rigid progress reports (default: true) */
  progressUpdates: boolean;
}

/**
 * Channel permissions
 */
export interface ChannelPermissions {
  /** Can send messages to this channel (default: true) */
  send: boolean;
  /** Can receive messages from this channel (default: true) */
  receive: boolean;
  /** Can control agent lifecycle (dispatch, stop) (default: true) */
  control: boolean;
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
  /** Channel type: determines bridge adapter and credential schema */
  type: ChannelType;
  credentials: Record<string, unknown>;
  options?: {
    permissions?: Partial<ChannelPermissions>;
    pushSettings?: Partial<PushSettings>;
    /** Channel-type-specific config passed through to the bridge adapter */
    adapterConfig?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface ChannelBridgeCallbacks {
  onMessage: (msg: ChannelMessage) => Promise<void>;
  onError: (err: Error) => void;
  onReady: () => void;
  onClose: () => void;
}
