import { APIClient } from '../api/APIClient';

/**
 * Batch operation types
 */
export enum BatchOperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete'
}

/**
 * Batch operation
 */
export interface BatchOperation {
  id: string;
  type: BatchOperationType;
  path: string;
  content?: string;
  fileId?: string;
  priority: number;
  timestamp: number;
}

/**
 * Batch result
 */
export interface BatchResult {
  success: boolean;
  operationId: string;
  path: string;
  error?: string;
}

/**
 * Batch execution result
 */
export interface BatchExecutionResult {
  totalOperations: number;
  successCount: number;
  failureCount: number;
  results: BatchResult[];
  duration: number;
}

/**
 * Batch configuration
 */
export interface BatchConfig {
  maxBatchSize: number;
  maxConcurrentBatches: number;
  batchDelayMs: number;
  retryAttempts: number;
  retryDelayMs: number;
}

/**
 * Default batch configuration
 */
const DEFAULT_BATCH_CONFIG: BatchConfig = {
  maxBatchSize: 5,
  maxConcurrentBatches: 3,
  batchDelayMs: 1000, // 1 second
  retryAttempts: 3,
  retryDelayMs: 1000
};

/**
 * Batch Service
 * Batches multiple file operations to reduce API request overhead
 * Implements request queuing and prioritization
 */
export class BatchService {
  private apiClient: APIClient;
  private config: BatchConfig;
  
  // Operation queue
  private operationQueue: BatchOperation[] = [];
  
  // Batch processing state
  private isProcessing: boolean = false;
  private batchTimer: NodeJS.Timeout | null = null;
  private activeBatches: number = 0;
  
  // Statistics
  private stats = {
    totalOperations: 0,
    successfulOperations: 0,
    failedOperations: 0,
    totalBatches: 0
  };

  constructor(apiClient: APIClient, config?: Partial<BatchConfig>) {
    this.apiClient = apiClient;
    this.config = { ...DEFAULT_BATCH_CONFIG, ...config };
  }

  /**
   * Add operation to batch queue
   */
  addOperation(operation: Omit<BatchOperation, 'id' | 'timestamp'>): string {
    const id = this.generateOperationId();
    const batchOp: BatchOperation = {
      ...operation,
      id,
      timestamp: Date.now()
    };
    
    this.operationQueue.push(batchOp);
    this.stats.totalOperations++;
    
    // Sort queue by priority (higher priority first)
    this.operationQueue.sort((a, b) => b.priority - a.priority);
    
    // Schedule batch processing
    this.scheduleBatchProcessing();
    
    return id;
  }

  /**
   * Add multiple operations to batch queue
   */
  addOperations(operations: Array<Omit<BatchOperation, 'id' | 'timestamp'>>): string[] {
    return operations.map(op => this.addOperation(op));
  }

  /**
   * Remove operation from queue
   */
  removeOperation(operationId: string): boolean {
    const index = this.operationQueue.findIndex(op => op.id === operationId);
    if (index !== -1) {
      this.operationQueue.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Clear all pending operations
   */
  clearQueue(): void {
    this.operationQueue = [];
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Get queue status
   */
  getQueueStatus(): {
    pendingOperations: number;
    activeBatches: number;
    isProcessing: boolean;
  } {
    return {
      pendingOperations: this.operationQueue.length,
      activeBatches: this.activeBatches,
      isProcessing: this.isProcessing
    };
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalOperations: number;
    successfulOperations: number;
    failedOperations: number;
    totalBatches: number;
    successRate: number;
  } {
    const successRate = this.stats.totalOperations > 0
      ? (this.stats.successfulOperations / this.stats.totalOperations) * 100
      : 0;
    
    return {
      ...this.stats,
      successRate
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalOperations: 0,
      successfulOperations: 0,
      failedOperations: 0,
      totalBatches: 0
    };
  }

  /**
   * Schedule batch processing
   */
  private scheduleBatchProcessing(): void {
    if (this.batchTimer) {
      return; // Already scheduled
    }
    
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.processBatches();
    }, this.config.batchDelayMs);
  }

  /**
   * Process batches
   */
  private processBatches(): void {
    if (this.isProcessing || this.operationQueue.length === 0) {
      return;
    }
    
    this.isProcessing = true;
    
    try {
      while (this.operationQueue.length > 0 && this.activeBatches < this.config.maxConcurrentBatches) {
        const batch = this.getNextBatch();
        if (batch.length === 0) break;
        
        this.activeBatches++;
        this.stats.totalBatches++;
        
        // Process batch asynchronously
        void this.executeBatch(batch).finally(() => {
          this.activeBatches--;

          // Continue processing if there are more operations
          if (this.operationQueue.length > 0) {
            void this.processBatches();
          }
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Get next batch of operations
   */
  private getNextBatch(): BatchOperation[] {
    const batchSize = Math.min(this.config.maxBatchSize, this.operationQueue.length);
    return this.operationQueue.splice(0, batchSize);
  }

  /**
   * Execute a batch of operations
   */
  private async executeBatch(operations: BatchOperation[]): Promise<BatchExecutionResult> {
    const startTime = Date.now();
    const results: BatchResult[] = [];
    
    // Group operations by vault
    const operationsByVault = this.groupOperationsByVault(operations);
    
    // Execute operations for each vault
    for (const [vaultId, vaultOps] of operationsByVault.entries()) {
      const vaultResults = await this.executeVaultOperations(vaultId, vaultOps);
      results.push(...vaultResults);
    }
    
    // Update statistics
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;
    
    this.stats.successfulOperations += successCount;
    this.stats.failedOperations += failureCount;
    
    return {
      totalOperations: operations.length,
      successCount,
      failureCount,
      results,
      duration: Date.now() - startTime
    };
  }

  /**
   * Group operations by vault ID
   */
  private groupOperationsByVault(operations: BatchOperation[]): Map<string, BatchOperation[]> {
    const grouped = new Map<string, BatchOperation[]>();
    
    for (const op of operations) {
      // Extract vault ID from path (assuming format: vaultId/path)
      const parts = op.path.split('/');
      const vaultId = parts[0];
      
      if (!grouped.has(vaultId)) {
        grouped.set(vaultId, []);
      }
      grouped.get(vaultId)!.push(op);
    }
    
    return grouped;
  }

  /**
   * Execute operations for a specific vault
   */
  private async executeVaultOperations(
    vaultId: string,
    operations: BatchOperation[]
  ): Promise<BatchResult[]> {
    const results: BatchResult[] = [];
    
    // Execute operations with retry logic
    for (const op of operations) {
      const result = await this.executeOperationWithRetry(vaultId, op);
      results.push(result);
    }
    
    return results;
  }

  /**
   * Execute a single operation with retry
   */
  private async executeOperationWithRetry(
    vaultId: string,
    operation: BatchOperation
  ): Promise<BatchResult> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < this.config.retryAttempts; attempt++) {
      try {
        await this.executeOperation(vaultId, operation);
        
        return {
          success: true,
          operationId: operation.id,
          path: operation.path
        };
      } catch (error) {
        lastError = error as Error;
        
        // Wait before retry
        if (attempt < this.config.retryAttempts - 1) {
          await this.delay(this.config.retryDelayMs * (attempt + 1));
        }
      }
    }
    
    return {
      success: false,
      operationId: operation.id,
      path: operation.path,
      error: lastError?.message || 'Unknown error'
    };
  }

  /**
   * Execute a single operation
   */
  private async executeOperation(vaultId: string, operation: BatchOperation): Promise<void> {
    const filePath = operation.path.replace(`${vaultId}/`, '');
    
    switch (operation.type) {
      case BatchOperationType.CREATE:
        if (!operation.content) {
          throw new Error('Content required for create operation');
        }
        await this.apiClient.createFile(vaultId, {
          path: filePath,
          content: operation.content
        });
        break;
        
      case BatchOperationType.UPDATE:
        if (!operation.content || !operation.fileId) {
          throw new Error('Content and fileId required for update operation');
        }
        await this.apiClient.updateFile(vaultId, operation.fileId, {
          content: operation.content
        });
        break;
        
      case BatchOperationType.DELETE:
        if (!operation.fileId) {
          throw new Error('FileId required for delete operation');
        }
        await this.apiClient.deleteFile(vaultId, operation.fileId);
        break;
        
      default:
        throw new Error(`Unknown operation type: ${String(operation.type)}`);
    }
  }

  /**
   * Generate unique operation ID
   */
  private generateOperationId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Force immediate batch processing
   */
  async flush(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    this.processBatches();
    
    // Wait for all active batches to complete
    while (this.activeBatches > 0) {
      await this.delay(100);
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<BatchConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get configuration
   */
  getConfig(): BatchConfig {
    return { ...this.config };
  }
}
