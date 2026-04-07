/**
 * Resource Observer for E2E tests
 * Monitors memory usage and resource consumption
 */

import { logger } from '../../../src/core/logger.js';
import type { AgentRegistry } from '../../../src/orchestration/agent-registry.js';

const log = logger.module('ResourceObserver');

export interface MemorySample {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  activeAgents: number;
}

export interface MemoryStats {
  initial: MemorySample | null;
  peak: MemorySample | null;
  final: MemorySample | null;
  samples: MemorySample[];
  growthMB: number;
  peakMB: number;
}

/**
 * Resource Observer
 * Monitors memory usage and system resources during tests
 */
export class ResourceObserver {
  private readonly registry?: AgentRegistry;
  
  private samplingInterval: NodeJS.Timeout | null = null;
  private samples: MemorySample[] = [];
  private isSampling: boolean = false;
  private sampleIntervalMs: number = 1000;

  constructor(registry?: AgentRegistry) {
    this.registry = registry;
    log.debug('ResourceObserver created', { hasRegistry: !!registry });
  }

  /**
   * Start memory sampling
   */
  start(sampleIntervalMs?: number): void {
    if (this.isSampling) {
      log.warn('ResourceObserver already sampling');
      return;
    }

    this.sampleIntervalMs = sampleIntervalMs ?? 1000;
    this.isSampling = true;
    this.samples = [];

    // Take initial sample
    this.takeSample();

    // Start periodic sampling
    this.samplingInterval = setInterval(() => {
      this.takeSample();
    }, this.sampleIntervalMs);

    log.debug('ResourceObserver started', { sampleIntervalMs: this.sampleIntervalMs });
  }

  /**
   * Stop memory sampling
   */
  stop(): void {
    if (!this.isSampling) {
      return;
    }

    if (this.samplingInterval) {
      clearInterval(this.samplingInterval);
      this.samplingInterval = null;
    }

    // Take final sample
    this.takeSample();

    this.isSampling = false;
    log.debug('ResourceObserver stopped', { totalSamples: this.samples.length });
  }

  /**
   * Take a memory sample
   */
  private takeSample(): void {
    const memUsage = process.memoryUsage();
    const activeAgents = this.registry ? this.registry.listAgents().length : 0;

    const sample: MemorySample = {
      timestamp: Date.now(),
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      rss: memUsage.rss,
      external: memUsage.external,
      arrayBuffers: memUsage.arrayBuffers ?? 0,
      activeAgents,
    };

    this.samples.push(sample);
    
    log.debug('Memory sample taken', {
      heapUsedMB: Math.round(sample.heapUsed / 1024 / 1024),
      rssMB: Math.round(sample.rss / 1024 / 1024),
      activeAgents: sample.activeAgents,
    });
  }

  /**
   * Assert memory growth is less than threshold (in MB)
   */
  assertMemoryGrowthLessThan(thresholdMB: number): void {
    const stats = this.getMemoryStats();
    
    if (!stats.initial || !stats.final) {
      throw new Error('Cannot assert memory growth: no samples available. Call start() first.');
    }

    const growthMB = stats.growthMB;
    
    if (growthMB >= thresholdMB) {
      throw new Error(
        `Memory growth ${growthMB.toFixed(2)}MB exceeded threshold ${thresholdMB}MB. ` +
        `Initial: ${this.formatMB(stats.initial.heapUsed)}, ` +
        `Final: ${this.formatMB(stats.final.heapUsed)}, ` +
        `Peak: ${stats.peakMB.toFixed(2)}MB`
      );
    }

    log.info('Memory growth assertion passed', { 
      growthMB: growthMB.toFixed(2), 
      thresholdMB,
      peakMB: stats.peakMB.toFixed(2),
    });
  }

  /**
   * Get peak memory usage in MB
   */
  getPeakMemory(): number {
    if (this.samples.length === 0) {
      return 0;
    }

    const peakSample = this.samples.reduce((peak, sample) => 
      sample.heapUsed > peak.heapUsed ? sample : peak
    );

    return peakSample.heapUsed / 1024 / 1024;
  }

  /**
   * Get memory timeline
   */
  getMemoryTimeline(): MemorySample[] {
    return [...this.samples];
  }

  /**
   * Get memory statistics
   */
  getMemoryStats(): MemoryStats {
    const initial = this.samples.length > 0 ? this.samples[0] : null;
    const final = this.samples.length > 0 ? this.samples[this.samples.length - 1] : null;
    
    const peak = this.samples.reduce<MemorySample | null>((peak, sample) => {
      if (!peak) return sample;
      return sample.heapUsed > peak.heapUsed ? sample : peak;
    }, null);

    const growthMB = initial && final 
      ? (final.heapUsed - initial.heapUsed) / 1024 / 1024 
      : 0;

    const peakMB = peak ? peak.heapUsed / 1024 / 1024 : 0;

    return {
      initial,
      peak,
      final,
      samples: [...this.samples],
      growthMB,
      peakMB,
    };
  }

  /**
   * Generate a human-readable report
   */
  generateReport(): string {
    const stats = this.getMemoryStats();
    
    if (this.samples.length === 0) {
      return 'ResourceObserver Report: No samples collected';
    }

    const lines = [
      '=== ResourceObserver Report ===',
      `Samples collected: ${this.samples.length}`,
      `Sample interval: ${this.sampleIntervalMs}ms`,
      '',
      'Memory Usage:',
      `  Initial heap: ${this.formatMB(stats.initial?.heapUsed ?? 0)}`,
      `  Peak heap: ${stats.peakMB.toFixed(2)}MB`,
      `  Final heap: ${this.formatMB(stats.final?.heapUsed ?? 0)}`,
      `  Growth: ${stats.growthMB.toFixed(2)}MB`,
      '',
      'System Memory:',
      `  RSS: ${this.formatMB(stats.final?.rss ?? 0)}`,
      `  External: ${this.formatMB(stats.final?.external ?? 0)}`,
      '',
      'Agent Activity:',
    ];

    if (this.registry) {
      const agentSamples = this.samples.filter(s => s.activeAgents > 0);
      if (agentSamples.length > 0) {
        const maxAgents = Math.max(...this.samples.map(s => s.activeAgents));
        const avgAgents = this.samples.reduce((sum, s) => sum + s.activeAgents, 0) / this.samples.length;
        lines.push(`  Max concurrent: ${maxAgents}`);
        lines.push(`  Average: ${avgAgents.toFixed(1)}`);
      } else {
        lines.push('  No active agents observed');
      }
    } else {
      lines.push('  (registry not provided)');
    }

    return lines.join('\n');
  }

  /**
   * Format bytes as MB string
   */
  private formatMB(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  }

  /**
   * Get current sample count
   */
  getSampleCount(): number {
    return this.samples.length;
  }

  /**
   * Check if currently sampling
   */
  isRunning(): boolean {
    return this.isSampling;
  }

  /**
   * Reset observer state
   */
  reset(): void {
    this.stop();
    this.samples = [];
    log.debug('ResourceObserver reset');
  }
}
