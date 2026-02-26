import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

const OUTPUT_HISTORY_LIMIT_CHARS = 512_000;
const EXIT_DRAIN_GRACE_MS = 25;
const MAX_TRACKED_SESSIONS = 128;
const DEFAULT_FAILURE_EXIT_CODE = -1;

export interface ExecCommandRuntimeInput {
  cmd: string;
  cwd: string;
  shell: string;
  login: boolean;
  yieldTimeMs: number;
  maxOutputTokens: number;
}

export interface WriteStdinRuntimeInput {
  sessionId: number;
  chars: string;
  yieldTimeMs: number;
  maxOutputTokens: number;
}

export type ExecCommandTermination =
  | { type: 'exited'; exitCode: number }
  | { type: 'ongoing'; sessionId: number };

export interface ExecCommandToolOutput {
  ok: boolean;
  exitCode: number;
  session_id?: number;
  wall_time_seconds: number;
  output: string;
  original_token_count?: number;
  termination: ExecCommandTermination;
  text: string;
}

interface ExecSession {
  id: number;
  child: ChildProcessWithoutNullStreams;
  createdAt: number;
  updatedAt: number;
  outputBuffer: string;
  outputBaseOffset: number;
  totalOutputChars: number;
  waiters: Set<() => void>;
  exited: boolean;
  exitCode: number;
  spawnError: string | null;
}

interface ReadFromCursorResult {
  text: string;
  nextCursor: number;
}

interface TruncateResult {
  output: string;
  originalTokenCount?: number;
}

export class CodexExecSessionManager {
  private nextSessionId = 1;
  private readonly sessions = new Map<number, ExecSession>();

  async executeCommand(input: ExecCommandRuntimeInput): Promise<ExecCommandToolOutput> {
    this.pruneExitedSessions();

    const sessionId = this.nextSessionId;
    this.nextSessionId += 1;

    const session = this.createSession(sessionId, input);
    this.sessions.set(sessionId, session);

    const startOffset = session.totalOutputChars;
    const startedAt = Date.now();
    const collected = await this.collectOutput(session, startOffset, input.yieldTimeMs, true);

    if (session.spawnError) {
      throw new Error(session.spawnError);
    }

    const truncated = truncateByTokenBudget(collected.output, input.maxOutputTokens);
    const wallTimeSeconds = (Date.now() - startedAt) / 1000;
    const termination: ExecCommandTermination = session.exited
      ? { type: 'exited', exitCode: session.exitCode }
      : { type: 'ongoing', sessionId: session.id };

    return formatOutput(wallTimeSeconds, termination, truncated.output, truncated.originalTokenCount);
  }

  async writeStdin(input: WriteStdinRuntimeInput): Promise<ExecCommandToolOutput> {
    this.pruneExitedSessions();

    const session = this.sessions.get(input.sessionId);
    if (!session) {
      throw new Error(`unknown session id ${input.sessionId}`);
    }

    const startOffset = session.totalOutputChars;
    const startedAt = Date.now();
    session.updatedAt = Date.now();

    if (input.chars.length > 0) {
      await this.writeChars(session, input.chars);
    }

    const collected = await this.collectOutput(session, startOffset, input.yieldTimeMs, false);
    const truncated = truncateByTokenBudget(collected.output, input.maxOutputTokens);
    const wallTimeSeconds = (Date.now() - startedAt) / 1000;
    const termination: ExecCommandTermination = session.exited
      ? { type: 'exited', exitCode: session.exitCode }
      : { type: 'ongoing', sessionId: session.id };

    return formatOutput(wallTimeSeconds, termination, truncated.output, truncated.originalTokenCount);
  }

  private createSession(sessionId: number, input: ExecCommandRuntimeInput): ExecSession {
    const shellMode = input.login ? '-lc' : '-c';
    const child = spawn(input.shell, [shellMode, input.cmd], {
      cwd: input.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const session: ExecSession = {
      id: sessionId,
      child,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      outputBuffer: '',
      outputBaseOffset: 0,
      totalOutputChars: 0,
      waiters: new Set<() => void>(),
      exited: false,
      exitCode: DEFAULT_FAILURE_EXIT_CODE,
      spawnError: null,
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.appendOutput(session, chunk);
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      this.appendOutput(session, chunk);
    });

    child.on('error', (error: Error) => {
      session.spawnError = error.message;
      session.exited = true;
      session.exitCode = DEFAULT_FAILURE_EXIT_CODE;
      this.notifyWaiters(session);
    });

    child.on('close', (code: number | null) => {
      session.exited = true;
      session.exitCode = code === null ? DEFAULT_FAILURE_EXIT_CODE : code;
      session.updatedAt = Date.now();
      this.notifyWaiters(session);
    });

    return session;
  }

  private appendOutput(session: ExecSession, chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    if (text.length === 0) {
      return;
    }

    session.outputBuffer += text;
    session.totalOutputChars += text.length;
    session.updatedAt = Date.now();

    const overflow = session.outputBuffer.length - OUTPUT_HISTORY_LIMIT_CHARS;
    if (overflow > 0) {
      session.outputBuffer = session.outputBuffer.slice(overflow);
      session.outputBaseOffset += overflow;
    }

    this.notifyWaiters(session);
  }

  private notifyWaiters(session: ExecSession): void {
    if (session.waiters.size === 0) {
      return;
    }
    const waiters = Array.from(session.waiters);
    session.waiters.clear();
    for (const notify of waiters) {
      notify();
    }
  }

  private async writeChars(session: ExecSession, chars: string): Promise<void> {
    if (!session.child.stdin.writable) {
      throw new Error(`failed to write to stdin for session ${session.id}`);
    }

    await new Promise<void>((resolve, reject) => {
      session.child.stdin.write(chars, 'utf-8', (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async collectOutput(
    session: ExecSession,
    startCursor: number,
    yieldTimeMs: number,
    stopOnExit: boolean,
  ): Promise<{ output: string }> {
    const chunks: string[] = [];
    let cursor = startCursor;
    const deadline = Date.now() + Math.max(0, Math.floor(yieldTimeMs));

    for (;;) {
      const drained = this.readOutputFromCursor(session, cursor);
      if (drained.text.length > 0) {
        chunks.push(drained.text);
      }
      cursor = drained.nextCursor;

      if (stopOnExit && session.exited) {
        await this.waitForSignal(session, EXIT_DRAIN_GRACE_MS);
        const finalDrain = this.readOutputFromCursor(session, cursor);
        if (finalDrain.text.length > 0) {
          chunks.push(finalDrain.text);
        }
        break;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      await this.waitForSignal(session, remainingMs);
    }

    return { output: chunks.join('') };
  }

  private readOutputFromCursor(session: ExecSession, cursor: number): ReadFromCursorResult {
    const base = session.outputBaseOffset;
    if (cursor < base) {
      const nextCursor = base + session.outputBuffer.length;
      return {
        text: session.outputBuffer,
        nextCursor,
      };
    }

    const relativeStart = cursor - base;
    if (relativeStart >= session.outputBuffer.length) {
      return { text: '', nextCursor: cursor };
    }

    const text = session.outputBuffer.slice(relativeStart);
    return {
      text,
      nextCursor: cursor + text.length,
    };
  }

  private waitForSignal(session: ExecSession, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        session.waiters.delete(onSignal);
        resolve();
      }, timeoutMs);

      const onSignal = () => {
        clearTimeout(timer);
        resolve();
      };

      session.waiters.add(onSignal);
    });
  }

  private pruneExitedSessions(): void {
    if (this.sessions.size <= MAX_TRACKED_SESSIONS) {
      return;
    }

    const candidates = Array.from(this.sessions.values())
      .filter((session) => session.exited)
      .sort((left, right) => left.updatedAt - right.updatedAt);

    let overflow = this.sessions.size - MAX_TRACKED_SESSIONS;
    for (const session of candidates) {
      if (overflow <= 0) break;
      this.sessions.delete(session.id);
      overflow -= 1;
    }
  }
}

function truncateByTokenBudget(output: string, maxOutputTokens: number): TruncateResult {
  const normalizedMaxTokens = Math.max(1, Math.floor(maxOutputTokens));
  const capBytes = normalizedMaxTokens * 4;
  const raw = Buffer.from(output, 'utf-8');

  if (raw.length <= capBytes) {
    return { output };
  }

  const headBytes = Math.floor(capBytes / 2);
  const tailBytes = capBytes - headBytes;
  const head = raw.subarray(0, headBytes).toString('utf-8');
  const tail = raw.subarray(raw.length - tailBytes).toString('utf-8');
  const originalTokenCount = Math.ceil(raw.length / 4);

  return {
    output: `${head}\n...[truncated]...\n${tail}`,
    originalTokenCount,
  };
}

function formatOutput(
  wallTimeSeconds: number,
  termination: ExecCommandTermination,
  output: string,
  originalTokenCount?: number,
): ExecCommandToolOutput {
  const terminationText =
    termination.type === 'exited'
      ? `Process exited with code ${termination.exitCode}`
      : `Process running with session ID ${termination.sessionId}`;
  const truncationText = originalTokenCount
    ? `\nWarning: truncated output (original token count: ${originalTokenCount})`
    : '';

  const text = `Wall time: ${wallTimeSeconds.toFixed(3)} seconds\n${terminationText}${truncationText}\nOutput:\n${output}`;

  const exitCode = termination.type === 'exited' ? termination.exitCode : 0;
  const sessionId = termination.type === 'ongoing' ? termination.sessionId : undefined;

  return {
    ok: termination.type === 'ongoing' ? true : termination.exitCode === 0,
    exitCode,
    session_id: sessionId,
    wall_time_seconds: wallTimeSeconds,
    output,
    original_token_count: originalTokenCount,
    termination,
    text,
  };
}
