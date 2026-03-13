/**
 * Date Utilities - 统一时间格式化工具
 */

/**
 * 格式化本地时间戳（带时区偏移）
 * 格式: 2026-03-13 16:19:47.608 +08:00
 */
export function formatLocalTimestamp(date?: Date): string {
  const now = date || new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const offset = -now.getTimezoneOffset();
  const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const offsetMinutes = String(Math.abs(offset) % 60).padStart(2, '0');
  const offsetSign = offset >= 0 ? '+' : '-';
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms} ${offsetSign}${offsetHours}:${offsetMinutes}`;
}
