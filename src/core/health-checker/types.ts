/**
 * Health Checker Types
 */

export interface HealthCheckResult {
  name: string;
  status: 'healthy' | 'warning' | 'critical';
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface SystemResourceStatus {
  diskSpace: {
    used: number;
    free: number;
    total: number;
    usagePercent: number;
    path: string;
  };
  memory: {
    total: number;
    used: number;
    free: number;
    usagePercent: number;
  };
  cpu: {
    usagePercent: number;
  };
  uptime: number;
}

export interface CleanupStats {
  sessionsRemoved: number;
  logsRemoved: number;
  backupsRemoved: number;
  totalSizeFreed: number;
}

export interface AIProviderCheckResult {
  providerId: string;
  status: 'connected' | 'disconnected' | 'error';
  message: string;
  latency?: number;
  timestamp: string;
}
