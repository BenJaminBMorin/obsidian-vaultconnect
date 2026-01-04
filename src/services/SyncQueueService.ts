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
   * Initialize queue from storage
   */
  async initialize(): Promise<void> {
    const stored = await this.storage.get<QueuedOperation[]>('syncQueue');
    if (stored && Array.isArray(stored)) {
      this.queue = stored.filter(op => op.status !== 'processing');
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

    await this.persistQueue();
    this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getQueueStats());

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
    console.debug('SyncQueueService: Stopped processing');
  }

  /**
   * Process queue operations
   */
  private async processQueue(): Promise<void> {
    while (this.isProcessing) {
      // Check if we can process more operations
      if (this.processing.size >= this.config.maxConcurrent) {
        await this.sleep(100);
        continue;
      }

      const operation = this.getNextOperation();
      if (!operation) {
        await this.sleep(100);
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
   * Persist queue to storage
   */
  private async persistQueue(): Promise<void> {
    try {
      await this.storage.set('syncQueue', this.queue);
    } catch (error) {
      console.error('Failed to persist sync queue:', error);
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
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
