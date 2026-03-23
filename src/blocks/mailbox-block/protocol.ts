export type MailboxLifecycleStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type MailboxTerminalStatus = 'completed' | 'failed';

export interface MailboxLifecycleMessageLike {
  status: MailboxLifecycleStatus;
  updatedAt: string;
  category?: string;
  readAt?: string;
  ackAt?: string;
  result?: unknown;
  error?: string;
}

export interface MailboxReadTransitionResult<T extends MailboxLifecycleMessageLike> {
  changed: boolean;
  movedToProcessing: boolean;
  message: T;
}

export interface MailboxAckOptions {
  status?: MailboxTerminalStatus;
  result?: unknown;
  error?: string;
}

export interface MailboxAckTransitionResult<T extends MailboxLifecycleMessageLike> {
  ok: boolean;
  changed: boolean;
  terminalStatus?: MailboxTerminalStatus;
  error?: string;
  alreadyAcked: boolean;
  message?: T;
}

export function applyMailboxReadTransition<T extends MailboxLifecycleMessageLike>(
  message: T,
  timestamp: string = new Date().toISOString(),
): MailboxReadTransitionResult<T> {
  const next = { ...message };
  let changed = false;
  let movedToProcessing = false;

  if (!next.readAt) {
    next.readAt = timestamp;
    changed = true;
  }

  if (next.status === 'pending' && next.category !== 'notification') {
    next.status = 'processing';
    movedToProcessing = true;
    changed = true;
  }

  if (changed) {
    next.updatedAt = timestamp;
  }

  return {
    changed,
    movedToProcessing,
    message: next,
  };
}

export function applyMailboxAckTransition<T extends MailboxLifecycleMessageLike>(
  message: T,
  options: MailboxAckOptions = {},
  timestamp: string = new Date().toISOString(),
): MailboxAckTransitionResult<T> {
  if (!message.readAt) {
    return {
      ok: false,
      changed: false,
      error: 'mailbox.ack requires mailbox.read(id) first',
      alreadyAcked: false,
    };
  }

  if (message.ackAt) {
    return {
      ok: true,
      changed: false,
      terminalStatus: message.status === 'failed' ? 'failed' : 'completed',
      alreadyAcked: true,
      message,
    };
  }

  const terminalStatus: MailboxTerminalStatus = options.status === 'failed'
    || (typeof options.error === 'string' && options.error.trim().length > 0)
    ? 'failed'
    : 'completed';

  const next = { ...message };
  next.status = terminalStatus;
  next.ackAt = timestamp;
  next.updatedAt = timestamp;

  if (options.result !== undefined) {
    next.result = options.result;
  }
  if (options.error !== undefined) {
    const normalizedError = options.error.trim();
    if (normalizedError.length > 0) {
      next.error = normalizedError;
    }
  }

  return {
    ok: true,
    changed: true,
    terminalStatus,
    alreadyAcked: false,
    message: next,
  };
}
