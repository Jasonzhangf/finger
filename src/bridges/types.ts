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
  options?: {
    permissions?: {
      send?: boolean;
      receive?: boolean;
      control?: boolean;
    };
    /** 推送设置 - 控制哪些内容推送到此 channel */
    pushSettings?: {
      /** 是否推送 reasoning/thinking 内容 */
      reasoning?: boolean;
      /** 是否推送状态更新 */
      statusUpdate?: boolean;
      /** 是否推送工具调用信息 */
      toolCalls?: boolean;
      /** 是否推送 step 更新（批量） */
      stepUpdates?: boolean;
      /** step 批量大小（累计 N 个 step 推送一次） */
      stepBatch?: number;
    };
    [key: string]: unknown;
  };
}

export interface ChannelBridgeCallbacks {
  onMessage: (msg: ChannelMessage) => Promise<void>;
  onError: (err: Error) => void;
  onReady: () => void;
  onClose: () => void;
}
