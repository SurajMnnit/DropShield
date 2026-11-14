import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export type FailurePoint =
  | 'REDIS_HOLD_FAILURE'
  | 'REDIS_CONFIRM_FAILURE'
  | 'REDIS_RELEASE_FAILURE'
  | 'DATABASE_QUERY_ABORT'
  | 'DATABASE_COMMIT_ABORT'
  | 'RABBITMQ_PUBLISH_FAIL'
  | 'PAYMENT_PROVIDER_TIMEOUT'
  | 'PAYMENT_AMBIGUOUS_RESULT'
  | 'OUTBOX_PUBLISHER_CRASH'
  | 'WORKER_CRASH_BEFORE_ACK'
  | 'EXPIRY_WORKER_INTERRUPTED';

export interface FailureConfig {
  point: FailurePoint;
  times?: number; // How many times to trigger before auto-clearing (default 1)
  error?: Error;
  delayMs?: number;
}

class FailureInjector {
  private activeFailures: Map<FailurePoint, FailureConfig> = new Map();

  private assertTestEnvironment(): void {
    if (env.NODE_ENV === 'production') {
      throw new Error('SECURITY VIOLATION: Failure injection is strictly prohibited in production environments.');
    }
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('Failure injection is only available when strictly in test environment.');
    }
  }

  /**
   * Register a failure hook to simulate infrastructure breakdown deterministically.
   */
  inject(config: FailureConfig): void {
    this.assertTestEnvironment();
    this.activeFailures.set(config.point, {
      ...config,
      times: config.times ?? 1,
    });
    logger.warn(`[FailureInjector] Activated hook: ${config.point} (times: ${config.times ?? 1})`);
  }

  /**
   * Check if a failure point is active, execute delay or throw error, and decrement trigger counter.
   */
  async trigger(point: FailurePoint): Promise<void> {
    if (env.NODE_ENV === 'production' || process.env.NODE_ENV !== 'test') {
      return;
    }

    const config = this.activeFailures.get(point);
    if (!config) return;

    if (config.delayMs && config.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.delayMs));
    }

    const remaining = (config.times ?? 1) - 1;
    if (remaining <= 0) {
      this.activeFailures.delete(point);
    } else {
      config.times = remaining;
    }

    logger.warn(`[FailureInjector] Triggered simulated failure at: ${point}`);
    throw config.error || new Error(`[SIMULATED_FAILURE] Injected error at ${point}`);
  }

  /**
   * Determine if a failure point is currently armed.
   */
  isArmed(point: FailurePoint): boolean {
    if (env.NODE_ENV === 'production' || process.env.NODE_ENV !== 'test') {
      return false;
    }
    return this.activeFailures.has(point);
  }

  /**
   * Remove a specific failure hook.
   */
  clear(point: FailurePoint): void {
    this.activeFailures.delete(point);
  }

  /**
   * Reset all failure hooks. Must be called in afterEach/afterAll blocks.
   */
  reset(): void {
    this.activeFailures.clear();
  }
}

export const failureInjector = new FailureInjector();
