import type { Express } from 'express';
import type { WebSocket } from 'ws';
import { performanceMonitor } from '../../runtime/performance-monitor.js';

export interface PerformanceRouteDeps {
  wsClients: Set<WebSocket>;
}

export function registerPerformanceRoutes(app: Express, deps: PerformanceRouteDeps): () => void {
  const { wsClients } = deps;

  app.get('/api/v1/performance', (_req, res) => {
    const metrics = performanceMonitor.getMetrics();
    res.json({
      success: true,
      metrics,
    });
  });

  app.get('/api/v1/performance/report', (_req, res) => {
    const report = performanceMonitor.generateReport();
    res.type('text/plain').send(report);
  });

  const intervalId = setInterval(() => {
    const metrics = performanceMonitor.getMetrics();
    const msg = JSON.stringify({
      type: 'performance_metrics',
      payload: metrics,
      timestamp: new Date().toISOString(),
    });

    for (const client of wsClients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }, 5000);

  console.log('[Server] Performance monitoring enabled');

  return () => clearInterval(intervalId);
}
