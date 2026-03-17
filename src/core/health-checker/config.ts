/**
 * Health Checker Configuration
 */

export const HEALTH_CHECK_CONFIG = {
  // 磁盘空间阈值（百分比）
  diskUsageWarningThreshold: 80,
  diskUsageCriticalThreshold: 90,

  // 内存阈值（百分比）
  memoryUsageWarningThreshold: 80,
  memoryUsageCriticalThreshold: 90,

  // CPU阈值（百分比）
  cpuUsageWarningThreshold: 80,
  cpuUsageCriticalThreshold: 90,

  // 资源清理配置
  sessionMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7天
  logMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7天
  backupMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7天

  // 检查间隔
  periodicCheckIntervalMs: 5 * 60 * 1000, // 5分钟
};
