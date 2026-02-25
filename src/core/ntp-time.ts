/**
 * NTP Time Provider
 * 
 * 提供带 NTP 偏移校正的时间戳
 */

export interface NtpTimeInfo {
  utc: string;
  local: string;
  tz: string;
  nowMs: number;
  ntpOffsetMs: number;
}

class NtpTimeProvider {
  private offsetMs: number = 0;
  private lastSyncAt: number = 0;
  private readonly syncIntervalMs: number = 5 * 60 * 1000; // 5分钟

  /**
   * 设置 NTP 偏移（由外部同步服务调用）
   */
  setOffset(offsetMs: number): void {
    this.offsetMs = offsetMs;
    this.lastSyncAt = Date.now();
  }

  /**
   * 获取当前带 NTP 校正的时间戳
   */
  getCorrectedTime(): NtpTimeInfo {
    const now = Date.now();
    const corrected = now + this.offsetMs;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const date = new Date(corrected);
    
    return {
      utc: date.toISOString(),
      local: this.formatLocalTime(date, tz),
      tz,
      nowMs: corrected,
      ntpOffsetMs: this.offsetMs,
    };
  }

  /**
   * 获取原始时间戳（不带校正）
   */
  getRawTime(): NtpTimeInfo {
    const now = Date.now();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const date = new Date(now);
    
    return {
      utc: date.toISOString(),
      local: this.formatLocalTime(date, tz),
      tz,
      nowMs: now,
      ntpOffsetMs: this.offsetMs,
    };
  }

  /**
   * 检查是否需要重新同步
   */
  needsSync(): boolean {
    return Date.now() - this.lastSyncAt > this.syncIntervalMs;
  }

  /**
   * 获取当前偏移值
   */
  getOffset(): number {
    return this.offsetMs;
  }

  private formatLocalTime(date: Date, tz: string): string {
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(date);

    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
    const offset = this.formatOffset(this.offsetMs);
    
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}.${String(date.getMilliseconds()).padStart(3, '0')} ${offset}`;
  }

  private formatOffset(offsetMs: number): string {
    const sign = offsetMs >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMs);
    const hours = Math.floor(abs / (60 * 60 * 1000));
    const minutes = Math.floor((abs % (60 * 60 * 1000)) / (60 * 1000));
    return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
}

// 单例导出
export const ntpTime = new NtpTimeProvider();
