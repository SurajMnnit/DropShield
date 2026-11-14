/**
 * In-memory operational metrics counters for DropShield.
 * Provides measurements, gauges, and counters for distributed inventory,
 * asynchronous messaging, payments, and reliability reconciliation.
 */

class MetricsRegistry {
  private counters: Map<string, number> = new Map();
  private timers: Map<string, number[]> = new Map();
  private gauges: Map<string, number> = new Map();

  increment(metric: string, value = 1): void {
    const current = this.counters.get(metric) || 0;
    this.counters.set(metric, current + value);
  }

  setGauge(metric: string, value: number): void {
    this.gauges.set(metric, value);
  }

  getGauge(metric: string): number {
    return this.gauges.get(metric) || 0;
  }

  recordDuration(metric: string, durationMs: number): void {
    const samples = this.timers.get(metric) || [];
    samples.push(durationMs);
    // Keep last 1000 samples for rolling averages
    if (samples.length > 1000) {
      samples.shift();
    }
    this.timers.set(metric, samples);
  }

  recordTiming(metric: string, durationMs: number): void {
    this.recordDuration(metric, durationMs);
  }

  getCounter(metric: string): number {
    return this.counters.get(metric) || 0;
  }

  getAverageDuration(metric: string): number {
    const samples = this.timers.get(metric) || [];
    if (samples.length === 0) return 0;
    const sum = samples.reduce((a, b) => a + b, 0);
    return Math.round((sum / samples.length) * 100) / 100;
  }

  getSnapshot(): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};
    for (const [key, value] of this.counters.entries()) {
      snapshot[key] = value;
    }
    for (const [key, value] of this.gauges.entries()) {
      snapshot[key] = value;
    }
    for (const [key, samples] of this.timers.entries()) {
      snapshot[`${key}_avg_ms`] = this.getAverageDuration(key);
      snapshot[`${key}_samples_count`] = samples.length;
    }
    return snapshot;
  }

  reset(): void {
    this.counters.clear();
    this.timers.clear();
    this.gauges.clear();
  }
}

export const metrics = new MetricsRegistry();
