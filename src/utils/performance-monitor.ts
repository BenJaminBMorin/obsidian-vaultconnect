/**
 * Performance Monitoring Utility
 * Tracks and reports performance metrics for the plugin
 */

export interface PerformanceMetric {
  name: string;
  duration: number;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface PerformanceReport {
  metrics: PerformanceMetric[];
  summary: {
    totalOperations: number;
    averageDuration: number;
    minDuration: number;
    maxDuration: number;
    p95Duration: number;
    p99Duration: number;
  };
}

export class PerformanceMonitor {
  private metrics: PerformanceMetric[] = [];
  private maxMetrics = 1000; // Keep last 1000 metrics
  private timers: Map<string, number> = new Map();

  /**
   * Start timing an operation
   */
  startTimer(name: string): void {
    this.timers.set(name, performance.now());
  }

  /**
   * End timing an operation and record the metric
   */
  endTimer(name: string, metadata?: Record<string, any>): number {
    const startTime = this.timers.get(name);
    if (!startTime) {
      console.warn(`No timer found for: ${name}`);
      return 0;
    }

    const duration = performance.now() - startTime;
    this.timers.delete(name);

    this.recordMetric({
      name,
      duration,
      timestamp: Date.now(),
      metadata
    });

    return duration;
  }

  /**
   * Measure an async operation
   */
  async measure<T>(
    name: string,
    operation: () => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    this.startTimer(name);
    try {
      const result = await operation();
      this.endTimer(name, metadata);
      return result;
    } catch (error) {
      this.endTimer(name, { ...metadata, error: true });
      throw error;
    }
  }

  /**
   * Measure a synchronous operation
   */
  measureSync<T>(
    name: string,
    operation: () => T,
    metadata?: Record<string, any>
  ): T {
    this.startTimer(name);
    try {
      const result = operation();
      this.endTimer(name, metadata);
      return result;
    } catch (error) {
      this.endTimer(name, { ...metadata, error: true });
      throw error;
    }
  }

  /**
   * Record a metric manually
   */
  recordMetric(metric: PerformanceMetric): void {
    this.metrics.push(metric);

    // Keep only the last N metrics to prevent memory issues
    if (this.metrics.length > this.maxMetrics) {
      this.metrics.shift();
    }
  }

  /**
   * Get metrics for a specific operation
   */
  getMetrics(name?: string): PerformanceMetric[] {
    if (name) {
      return this.metrics.filter(m => m.name === name);
    }
    return [...this.metrics];
  }

  /**
   * Get performance report
   */
  getReport(name?: string): PerformanceReport {
    const metrics = this.getMetrics(name);
    
    if (metrics.length === 0) {
      return {
        metrics: [],
        summary: {
          totalOperations: 0,
          averageDuration: 0,
          minDuration: 0,
          maxDuration: 0,
          p95Duration: 0,
          p99Duration: 0
        }
      };
    }

    const durations = metrics.map(m => m.duration).sort((a, b) => a - b);
    const sum = durations.reduce((acc, d) => acc + d, 0);

    return {
      metrics,
      summary: {
        totalOperations: metrics.length,
        averageDuration: sum / metrics.length,
        minDuration: durations[0],
        maxDuration: durations[durations.length - 1],
        p95Duration: this.percentile(durations, 95),
        p99Duration: this.percentile(durations, 99)
      }
    };
  }

  /**
   * Calculate percentile
   */
  private percentile(sortedArray: number[], percentile: number): number {
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[Math.max(0, index)];
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics = [];
    this.timers.clear();
  }

  /**
   * Get memory usage information
   */
  getMemoryUsage(): {
    heapUsed: number;
    heapTotal: number;
    external: number;
  } | null {
    if (typeof process !== 'undefined' && process.memoryUsage) {
      const usage = process.memoryUsage();
      return {
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        external: usage.external
      };
    }
    return null;
  }

  /**
   * Log performance report to console
   */
  logReport(name?: string): void {
    const report = this.getReport(name);
    const title = name ? `Performance Report: ${name}` : 'Performance Report';

    const memory = this.getMemoryUsage();
    const memoryInfo = memory
      ? `\n  Heap Used: ${(memory.heapUsed / 1024 / 1024).toFixed(2)} MB\n  Heap Total: ${(memory.heapTotal / 1024 / 1024).toFixed(2)} MB`
      : '';

    console.debug(
      `${title}\n` +
      `  Total Operations: ${report.summary.totalOperations}\n` +
      `  Average Duration: ${report.summary.averageDuration.toFixed(2)} ms\n` +
      `  Min Duration: ${report.summary.minDuration.toFixed(2)} ms\n` +
      `  Max Duration: ${report.summary.maxDuration.toFixed(2)} ms\n` +
      `  P95 Duration: ${report.summary.p95Duration.toFixed(2)} ms\n` +
      `  P99 Duration: ${report.summary.p99Duration.toFixed(2)} ms` +
      memoryInfo
    );
  }

  /**
   * Export metrics as JSON
   */
  exportMetrics(): string {
    return JSON.stringify({
      metrics: this.metrics,
      report: this.getReport(),
      timestamp: Date.now()
    }, null, 2);
  }

  /**
   * Check if operation meets performance threshold
   */
  checkThreshold(name: string, thresholdMs: number): boolean {
    const metrics = this.getMetrics(name);
    if (metrics.length === 0) return true;

    const report = this.getReport(name);
    return report.summary.p95Duration <= thresholdMs;
  }

  /**
   * Get slow operations (above threshold)
   */
  getSlowOperations(thresholdMs: number): PerformanceMetric[] {
    return this.metrics.filter(m => m.duration > thresholdMs);
  }
}

// Singleton instance
export const performanceMonitor = new PerformanceMonitor();

// Helper decorator for measuring method performance
export function measurePerformance(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const originalMethod = descriptor.value;

  descriptor.value = async function (...args: any[]) {
    const name = `${target.constructor.name}.${propertyKey}`;
    return performanceMonitor.measure(name, () => originalMethod.apply(this, args));
  };

  return descriptor;
}
