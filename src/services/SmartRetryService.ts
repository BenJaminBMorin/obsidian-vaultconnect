/**
 * Smart Retry Service
 * Implements intelligent retry logic with exponential backoff, jitter, and circuit breaker
 */

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.3,
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 30000
};

export class SmartRetryService {
  private config: RetryConfig;
  private failureCount = 0;
  private circuitOpen = false;
  private lastFailureTime = 0;
  private consecutiveSuccesses = 0;

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * Calculate delay with exponential backoff and jitter
   */
  calculateDelay(attempt: number): number {
    // Exponential backoff: baseDelay * 2^attempt
    const exponentialDelay = this.config.baseDelayMs * Math.pow(2, attempt);
    const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);
    
    // Add jitter to prevent thundering herd problem
    // Jitter is a random value between 0 and (delay * jitterFactor)
    const jitter = cappedDelay * this.config.jitterFactor * Math.random();
    
    return Math.floor(cappedDelay + jitter);
  }

  /**
   * Check if circuit breaker is open
   */
  isCircuitOpen(): boolean {
    if (!this.circuitOpen) return false;
    
    // Auto-reset circuit breaker after timeout
    const timeSinceLastFailure = Date.now() - this.lastFailureTime;
    if (timeSinceLastFailure > this.config.circuitBreakerResetMs) {
      console.debug('[SmartRetry] Circuit breaker reset after timeout');
      this.circuitOpen = false;
      this.failureCount = 0;
      return false;
    }
    
    return true;
  }

  /**
   * Record a failure
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.consecutiveSuccesses = 0;
    
    if (this.failureCount >= this.config.circuitBreakerThreshold) {
      console.warn(`[SmartRetry] Circuit breaker opened after ${this.failureCount} failures`);
      this.circuitOpen = true;
    }
  }

  /**
   * Record a success
   */
  recordSuccess(): void {
    this.consecutiveSuccesses++;
    
    // Gradually reduce failure count on success
    if (this.consecutiveSuccesses >= 2) {
      this.failureCount = Math.max(0, this.failureCount - 1);
      this.consecutiveSuccesses = 0;
    }
    
    // Reset circuit breaker on success
    if (this.circuitOpen && this.consecutiveSuccesses >= 1) {
      console.debug('[SmartRetry] Circuit breaker reset after successful operation');
      this.circuitOpen = false;
      this.failureCount = 0;
    }
  }

  /**
   * Suggest smaller chunk size based on failure count
   */
  suggestChunkSize(currentSize: number, failureCount: number): number {
    if (failureCount < 2) return currentSize;
    
    // Reduce by 50% for each failure beyond the first
    const reduction = Math.pow(0.5, failureCount - 1);
    const newSize = Math.floor(currentSize * reduction);
    
    // Minimum 256KB chunks
    const minSize = 256 * 1024;
    return Math.max(newSize, minSize);
  }

  /**
   * Check if error is retryable
   */
  isRetryableError(error: unknown): boolean {
    const errorObj = error as { message?: string };
    const message = errorObj?.message || String(error);
    const lowerMessage = message.toLowerCase();
    
    // Non-retryable errors
    const nonRetryable = [
      '401', 'unauthorized',
      '403', 'forbidden',
      '404', 'not found',
      '400', 'bad request',
      'invalid', 'malformed'
    ];
    
    for (const pattern of nonRetryable) {
      if (lowerMessage.includes(pattern)) {
        return false;
      }
    }
    
    // Retryable errors (network, timeout, server errors)
    const retryable = [
      '408', 'timeout',
      '429', 'too many requests',
      '500', 'internal server',
      '502', 'bad gateway',
      '503', 'service unavailable',
      '504', 'gateway timeout',
      'network', 'connection', 'econnreset', 'etimedout'
    ];
    
    for (const pattern of retryable) {
      if (lowerMessage.includes(pattern)) {
        return true;
      }
    }
    
    // Default to retryable for unknown errors
    return true;
  }

  /**
   * Get current stats
   */
  getStats(): {
    failureCount: number;
    circuitOpen: boolean;
    consecutiveSuccesses: number;
  } {
    return {
      failureCount: this.failureCount,
      circuitOpen: this.circuitOpen,
      consecutiveSuccesses: this.consecutiveSuccesses
    };
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.failureCount = 0;
    this.circuitOpen = false;
    this.lastFailureTime = 0;
    this.consecutiveSuccesses = 0;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RetryConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
