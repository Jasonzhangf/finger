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
  /** Unique identifier for this attachment */
  id?: string;
  /** Logical type, includes channel media + internal code artifact */
  type: 'image' | 'audio' | 'video' | 'file' | 'code';
  url: string;
  /** Display name used by runtime/session layers */
  name?: string;
  /** Original filename from sender */
  filename?: string;
  /** File size in bytes */
  size?: number;
  /** MIME type (e.g. image/png, image/jpeg) */
  mimeType?: string;
  /** Image width in pixels (for image type) */
  width?: number;
  /** Image height in pixels (for image type) */
  height?: number;
  /** Thumbnail URL (for image type, smaller preview) */
  thumbnailUrl?: string;
  /** Source channel where this attachment originated (for tracing) */
  source?: string;
  /** Optional extension metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Unified attachment type alias used by runtime/session/ledger and channel bridges.
 */
export type Attachment = ChannelAttachment;

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
  /** Push assistant body/content updates (default: false) */
  bodyUpdates: boolean;
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
    /**
     * Cross-channel mirror settings.
     *
     * Example:
     * sync: {
     *   enabled: true,
     *   targets: ["qqbot", "openclaw-weixin", "webui"],
     *   targetOverrides: {
     *     "qqbot": "F6A6...",
     *     "openclaw-weixin": "o9cq...@im.wechat"
     *   }
     * }
     */
    sync?: {
      enabled?: boolean;
      targets?: string[];
      targetOverrides?: Record<string, string>;
    };
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
