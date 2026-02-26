import { EventBus, EVENTS } from '../core/EventBus';
import { StorageManager } from '../core/StorageManager';

/**
 * Queued file operation
 */
export interface QueuedOperation {
  id: string;
  path: string;
  operation: 'create' | 'update' | 'delete' | 'rename';
  content?: string;
  oldPath?: string;
  timestamp: number;
  retries: number;
  priority: number;
  status: 'pending' | 'processing' | 'failed';
  error?: string;
}

/**
 * Queue configuration
 */
export interface QueueConfig {
  maxRetries: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  maxConcurrent: number;
}

/**
 * Service for managing sync operation queue with retry logic
 */
export class SyncQueueService {
  private eventBus: EventBus;
  private storage: StorageManager;
  private config: QueueConfig;
  private queue: QueuedOperation[] = [];
  private processing: Set<string> = new Set();
  private isProcessing: boolean = false;

  // Event-driven signal: resolved when work is enqueued or processing should wake
  private wakeSignal: Promise<void> = Promise.resolve();
  private wakeResolve: (() => void) | null = null;

  constructor(
    eventBus: EventBus,
    storage: StorageManager,
    config: QueueConfig
  ) {
    this.eventBus = eventBus;
    this.storage = storage;
    this.config = config;
  }

  /**
   * Initialize queue from storage, cleaning up stale entries
   */
  async initialize(): Promise<void> {
    const stored = await this.storage.get<QueuedOperation[]>('syncQueue');
    if (stored && Array.isArray(stored)) {
      const ONE_DAY = 24 * 60 * 60 * 1000;
      this.queue = stored.filter(op => {
        // Remove stale processing ops (interrupted)
        if (op.status === 'processing') return false;
        // Remove failed ops older than 24 hours
        if (op.status === 'failed' && Date.now() - op.timestamp > ONE_DAY) return false;
        return true;
      });
      if (this.queue.length !== stored.length) {
        console.debug(`Cleaned up ${stored.length - this.queue.length} stale queue entries`);
        await this.persistQueue();
      }
      console.debug(`Loaded ${this.queue.length} queued operations from storage`);
    }
  }

  /**
   * Add operation to queue
   */
  async enqueue(
    path: string,
    operation: 'create' | 'update' | 'delete' | 'rename',
    content?: string,
    oldPath?: string,
    priority: number = 0
  ): Promise<string> {
    const id = this.generateOperationId();
    
    const queuedOp: QueuedOperation = {
      id,
      path,
      operation,
      content,
      oldPath,
      timestamp: Date.now(),
      retries: 0,
      priority,
      status: 'pending'
    };

    // Check if there's already a pending operation for this file
    const existingIndex = this.queue.findIndex(
      op => op.path === path && op.status === 'pending'
    );

    if (existingIndex !== -1) {
      // Replace existing operation with newer one
      this.queue[existingIndex] = queuedOp;
      console.debug(`Updated existing queue operation for ${path}`);
    } else {
      // Add new operation
      this.queue.push(queuedOp);
      console.debug(`Enqueued ${operation} operation for ${path}`);
    }

    // Sort by priority (higher first) and timestamp (older first)
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.timestamp - b.timestamp;
    });

    this.enforceQueueCap();
    await this.persistQueue();
    this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getQueueStats());

    // Wake the processing loop immediately so it picks up the new work
    this.wake();

    return id;
  }

  /**
   * Remove operation from queue
   */
  async dequeue(id: string): Promise<void> {
    const index = this.queue.findIndex(op => op.id === id);
    if (index !== -1) {
      this.queue.splice(index, 1);
      await this.persistQueue();
      this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getQueueStats());
    }
  }

  /**
   * Get next operation to process
   */
  private getNextOperation(): QueuedOperation | null {
    // Find first pending operation that's not being processed
    return this.queue.find(
      op => op.status === 'pending' && !this.processing.has(op.id)
    ) || null;
  }

  /**
   * Start processing queue
   */
  startProcessing(): void {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    console.debug('SyncQueueService: Started processing');
    void this.processQueue();
  }

  /**
   * Stop processing queue
   */
  stopProcessing(): void {
    this.isProcessing = false;
    // Wake the loop so it exits immediately instead of waiting for timeout
    this.wake();
    console.debug('SyncQueueService: Stopped processing');
  }

  /**
   * Process queue operations
   */
  private async processQueue(): Promise<void> {
    while (this.isProcessing) {
      // Check if we can process more operations
      if (this.processing.size >= this.config.maxConcurrent) {
        await this.sleepOrWake(1000);
        continue;
      }

      const operation = this.getNextOperation();
      if (!operation) {
        // No work available — wait for wake signal or periodic check
        await this.sleepOrWake(5000);
        continue;
      }

      // Mark as processing
      operation.status = 'processing';
      this.processing.add(operation.id);
      await this.persistQueue();

      // Process operation asynchronously
      this.processOperation(operation).catch(error => {
        console.error('Error processing operation:', error);
      });
    }
  }

  /**
   * Process a single operation
   */
  private async processOperation(operation: QueuedOperation): Promise<void> {
    try {
      console.debug(`Processing ${operation.operation} for ${operation.path}`);

      // Emit event for external handler to process
      const result = await new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Operation timeout'));
        }, 30000); // 30 second timeout

        this.eventBus.once(`sync:operation:${operation.id}:result`, (success: boolean, error?: string) => {
          clearTimeout(timeout);
          if (success) {
            resolve(true);
          } else {
            reject(new Error(error || 'Operation failed'));
          }
        });

        this.eventBus.emit(EVENTS.SYNC_STARTED, operation);
      });

      if (result) {
        // Success - remove from queue
        await this.dequeue(operation.id);
        this.processing.delete(operation.id);
        console.debug(`Successfully processed ${operation.operation} for ${operation.path}`);
      }
    } catch (error) {
      console.error(`Failed to process ${operation.operation} for ${operation.path}:`, error);
      
      // Handle failure with retry logic
      operation.retries++;
      operation.status = 'pending';
      operation.error = error instanceof Error ? error.message : String(error);

      if (operation.retries >= this.config.maxRetries) {
        // Max retries reached - mark as failed
        operation.status = 'failed';
        console.error(`Max retries reached for ${operation.path}`);
        this.eventBus.emit(EVENTS.SYNC_ERROR, {
          operation,
          error: 'Max retries reached'
        });
      } else {
        // Schedule retry with exponential backoff
        const delay = this.calculateRetryDelay(operation.retries);
        console.debug(`Retrying ${operation.path} in ${delay}ms (attempt ${operation.retries + 1}/${this.config.maxRetries})`);
        
        setTimeout(() => {
          operation.status = 'pending';
          void this.persistQueue();
        }, delay);
      }

      this.processing.delete(operation.id);
      await this.persistQueue();
      this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getQueueStats());
    }
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateRetryDelay(retryCount: number): number {
    const delay = this.config.retryDelayMs * Math.pow(2, retryCount);
    return Math.min(delay, this.config.maxRetryDelayMs);
  }

  /**
   * Persist queue to storage — content is stripped to prevent data.json bloat
   */
  private async persistQueue(): Promise<void> {
    try {
      const stripped = this.queue.map(op => ({
        ...op,
        content: undefined
      }));
      await this.storage.set('syncQueue', stripped);
    } catch (error) {
      console.error('Failed to persist sync queue:', error);
    }
  }

  /**
   * Enforce max queue size of 500. Evicts oldest failed ops first, then oldest pending.
   */
  private enforceQueueCap(): void {
    const MAX_QUEUE = 500;
    if (this.queue.length <= MAX_QUEUE) return;

    // Remove failed ops first (oldest first)
    const failed = this.queue
      .filter(op => op.status === 'failed')
      .sort((a, b) => a.timestamp - b.timestamp);
    while (this.queue.length > MAX_QUEUE && failed.length > 0) {
      const op = failed.shift()!;
      this.queue = this.queue.filter(q => q.id !== op.id);
    }

    // If still over cap, remove oldest pending
    if (this.queue.length > MAX_QUEUE) {
      const pending = this.queue
        .filter(op => op.status === 'pending')
        .sort((a, b) => a.timestamp - b.timestamp);
      while (this.queue.length > MAX_QUEUE && pending.length > 0) {
        const op = pending.shift()!;
        this.queue = this.queue.filter(q => q.id !== op.id);
      }
    }
  }

  /**
   * Get queue statistics
   */
  getQueueStats(): {
    total: number;
    pending: number;
    processing: number;
    failed: number;
  } {
    return {
      total: this.queue.length,
      pending: this.queue.filter(op => op.status === 'pending').length,
      processing: this.queue.filter(op => op.status === 'processing').length,
      failed: this.queue.filter(op => op.status === 'failed').length
    };
  }

  /**
   * Get all queued operations
   */
  getQueue(): QueuedOperation[] {
    return [...this.queue];
  }

  /**
   * Get operations for a specific file
   */
  getOperationsForFile(path: string): QueuedOperation[] {
    return this.queue.filter(op => op.path === path);
  }

  /**
   * Clear all failed operations
   */
  async clearFailed(): Promise<void> {
    this.queue = this.queue.filter(op => op.status !== 'failed');
    await this.persistQueue();
    this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getQueueStats());
  }

  /**
   * Clear entire queue
   */
  async clearQueue(): Promise<void> {
    this.queue = [];
    this.processing.clear();
    await this.persistQueue();
    this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getQueueStats());
  }

  /**
   * Retry failed operations
   */
  async retryFailed(): Promise<void> {
    const failedOps = this.queue.filter(op => op.status === 'failed');
    failedOps.forEach(op => {
      op.status = 'pending';
      op.retries = 0;
      op.error = undefined;
    });
    
    if (failedOps.length > 0) {
      await this.persistQueue();
      this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getQueueStats());
      this.wake();
      console.debug(`Retrying ${failedOps.length} failed operations`);
    }
  }

  /**
   * Generate unique operation ID
   */
  private generateOperationId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Sleep helper with early wake support.
   * Returns a promise that resolves after `ms` milliseconds OR when wake() is called.
   */
  private sleepOrWake(ms: number): Promise<void> {
    // Create a new wake signal that can be resolved externally
    this.wakeSignal = new Promise<void>(resolve => {
      this.wakeResolve = resolve;
    });

    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        resolve();
      }, ms);

      // Also resolve if wakeSignal fires (work arrived)
      this.wakeSignal.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Wake the processing loop immediately (called when new work is enqueued)
   */
  private wake(): void {
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Check if processing
   */
  isActive(): boolean {
    return this.isProcessing;
  }
}
