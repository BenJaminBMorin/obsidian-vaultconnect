import { EventBus, EVENTS } from '../core/EventBus';
import { StorageManager } from '../core/StorageManager';

/**
 * Offline queued operation
 */
export interface OfflineOperation {
  id: string;
  path: string;
  operation: 'create' | 'update' | 'delete' | 'rename';
  content?: string;
  oldPath?: string;
  timestamp: number;
  queuedAt: number;
  status: 'queued' | 'syncing' | 'synced' | 'failed';
  error?: string;
  retries: number;
}

/**
 * Offline queue statistics
 */
export interface OfflineQueueStats {
  total: number;
  queued: number;
  syncing: number;
  synced: number;
  failed: number;
  oldestTimestamp: number | null;
}

/**
 * Service for managing offline operation queue
 * Queues all changes during offline mode and syncs when reconnected
 */
export class OfflineQueueService {
  private eventBus: EventBus;
  private storage: StorageManager;
  private queue: OfflineOperation[] = [];
  private isOffline: boolean = false;
  private maxQueueSize: number = 1000;

  constructor(
    eventBus: EventBus,
    storage: StorageManager,
    maxQueueSize: number = 1000
  ) {
    this.eventBus = eventBus;
    this.storage = storage;
    this.maxQueueSize = maxQueueSize;

    this.setupEventListeners();
  }

  /**
   * Initialize queue from storage
   */
  async initialize(): Promise<void> {
    const stored = await this.storage.get<OfflineOperation[]>('offlineQueue');
    if (stored && Array.isArray(stored)) {
      // Filter out already synced operations
      this.queue = stored.filter(op => op.status !== 'synced');
      console.debug(`OfflineQueueService: Loaded ${this.queue.length} queued operations from storage`);
      
      if (this.queue.length > 0) {
        this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getStats());
      }
    }
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen for offline mode changes
    this.eventBus.on(EVENTS.OFFLINE_MODE_CHANGED, (offline: boolean) => {
      this.isOffline = offline;
      console.debug(`OfflineQueueService: Offline mode ${offline ? 'enabled' : 'disabled'}`);
    });
  }

  /**
   * Add operation to offline queue
   */
  async enqueue(
    path: string,
    operation: 'create' | 'update' | 'delete' | 'rename',
    content?: string,
    oldPath?: string
  ): Promise<string> {
    // Check queue size limit
    if (this.queue.length >= this.maxQueueSize) {
      console.warn('OfflineQueueService: Queue is full, removing oldest operation');
      this.queue.shift();
    }

    const id = this.generateOperationId();
    const now = Date.now();

    const queuedOp: OfflineOperation = {
      id,
      path,
      operation,
      content,
      oldPath,
      timestamp: now,
      queuedAt: now,
      status: 'queued',
      retries: 0
    };

    // Check if there's already a queued operation for this file
    const existingIndex = this.queue.findIndex(
      op => op.path === path && op.status === 'queued'
    );

    if (existingIndex !== -1) {
      // Replace existing operation with newer one
      const oldOp = this.queue[existingIndex];
      queuedOp.queuedAt = oldOp.queuedAt; // Keep original queue time
      this.queue[existingIndex] = queuedOp;
      console.debug(`OfflineQueueService: Updated existing queue operation for ${path}`);
    } else {
      // Add new operation
      this.queue.push(queuedOp);
      console.debug(`OfflineQueueService: Enqueued ${operation} operation for ${path}`);
    }

    await this.persistQueue();
    this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getStats());

    return id;
  }

  /**
   * Get next operation to sync
   */
  getNextOperation(): OfflineOperation | null {
    return this.queue.find(op => op.status === 'queued') || null;
  }

  /**
   * Mark operation as syncing
   */
  async markAsSyncing(id: string): Promise<void> {
    const operation = this.queue.find(op => op.id === id);
    if (operation) {
      operation.status = 'syncing';
      await this.persistQueue();
      this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getStats());
    }
  }

  /**
   * Mark operation as synced
   */
  async markAsSynced(id: string): Promise<void> {
    const index = this.queue.findIndex(op => op.id === id);
    if (index !== -1) {
      this.queue[index].status = 'synced';

      // Remove synced operations after a short delay
      void setTimeout(() => {
        void (async () => {
          const idx = this.queue.findIndex(op => op.id === id);
          if (idx !== -1 && this.queue[idx].status === 'synced') {
            this.queue.splice(idx, 1);
            await this.persistQueue();
            this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getStats());
          }
        })();
      }, 5000); // Keep for 5 seconds for UI feedback
      
      await this.persistQueue();
      this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getStats());
    }
  }

  /**
   * Mark operation as failed
   */
  async markAsFailed(id: string, error: string): Promise<void> {
    const operation = this.queue.find(op => op.id === id);
    if (operation) {
      operation.status = 'failed';
      operation.error = error;
      operation.retries++;
      await this.persistQueue();
      this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getStats());
    }
  }

  /**
   * Retry failed operation
   */
  async retryOperation(id: string): Promise<void> {
    const operation = this.queue.find(op => op.id === id);
    if (operation && operation.status === 'failed') {
      operation.status = 'queued';
      operation.error = undefined;
      await this.persistQueue();
      this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getStats());
      console.debug(`OfflineQueueService: Retrying operation ${id}`);
    }
  }

  /**
   * Retry all failed operations
   */
  async retryAllFailed(): Promise<void> {
    const failedOps = this.queue.filter(op => op.status === 'failed');
    
    for (const op of failedOps) {
      op.status = 'queued';
      op.error = undefined;
    }
    
    if (failedOps.length > 0) {
      await this.persistQueue();
      this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getStats());
      console.debug(`OfflineQueueService: Retrying ${failedOps.length} failed operations`);
    }
  }

  /**
   * Remove operation from queue
   */
  async removeOperation(id: string): Promise<void> {
    const index = this.queue.findIndex(op => op.id === id);
    if (index !== -1) {
      this.queue.splice(index, 1);
      await this.persistQueue();
      this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getStats());
      console.debug(`OfflineQueueService: Removed operation ${id}`);
    }
  }

  /**
   * Clear all synced operations
   */
  async clearSynced(): Promise<void> {
    const beforeCount = this.queue.length;
    this.queue = this.queue.filter(op => op.status !== 'synced');
    const removedCount = beforeCount - this.queue.length;
    
    if (removedCount > 0) {
      await this.persistQueue();
      this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getStats());
      console.debug(`OfflineQueueService: Cleared ${removedCount} synced operations`);
    }
  }

  /**
   * Clear all failed operations
   */
  async clearFailed(): Promise<void> {
    const beforeCount = this.queue.length;
    this.queue = this.queue.filter(op => op.status !== 'failed');
    const removedCount = beforeCount - this.queue.length;
    
    if (removedCount > 0) {
      await this.persistQueue();
      this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getStats());
      console.debug(`OfflineQueueService: Cleared ${removedCount} failed operations`);
    }
  }

  /**
   * Clear entire queue
   */
  async clearQueue(): Promise<void> {
    const count = this.queue.length;
    this.queue = [];
    await this.persistQueue();
    this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.getStats());
    console.debug(`OfflineQueueService: Cleared ${count} operations from queue`);
  }

  /**
   * Get all queued operations
   */
  getQueue(): OfflineOperation[] {
    return [...this.queue];
  }

  /**
   * Get operations for a specific file
   */
  getOperationsForFile(path: string): OfflineOperation[] {
    return this.queue.filter(op => op.path === path);
  }

  /**
   * Get queue statistics
   */
  getStats(): OfflineQueueStats {
    const queued = this.queue.filter(op => op.status === 'queued');
    const syncing = this.queue.filter(op => op.status === 'syncing');
    const synced = this.queue.filter(op => op.status === 'synced');
    const failed = this.queue.filter(op => op.status === 'failed');
    
    const oldestTimestamp = queued.length > 0
      ? Math.min(...queued.map(op => op.queuedAt))
      : null;

    return {
      total: this.queue.length,
      queued: queued.length,
      syncing: syncing.length,
      synced: synced.length,
      failed: failed.length,
      oldestTimestamp
    };
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.queue.filter(op => op.status === 'queued').length === 0;
  }

  /**
   * Check if queue has pending operations
   */
  hasPendingOperations(): boolean {
    return this.queue.some(op => op.status === 'queued' || op.status === 'syncing');
  }

  /**
   * Get count of queued operations
   */
  getQueuedCount(): number {
    return this.queue.filter(op => op.status === 'queued').length;
  }

  /**
   * Check if in offline mode
   */
  isInOfflineMode(): boolean {
    return this.isOffline;
  }

  /**
   * Persist queue to storage
   */
  private async persistQueue(): Promise<void> {
    try {
      await this.storage.set('offlineQueue', this.queue);
    } catch (error) {
      console.error('OfflineQueueService: Failed to persist queue:', error);
    }
  }

  /**
   * Generate unique operation ID
   */
  private generateOperationId(): string {
    return `offline_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.queue = [];
  }
}
