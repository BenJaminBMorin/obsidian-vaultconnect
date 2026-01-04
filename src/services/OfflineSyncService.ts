import { TFile, Vault } from 'obsidian';
import { APIClient } from '../api/APIClient';
import { EventBus, EVENTS } from '../core/EventBus';
import { StorageManager } from '../core/StorageManager';
import { OfflineQueueService, OfflineOperation } from './OfflineQueueService';
import { FileSyncService } from './FileSyncService';
import { FileInfo, FileContent, ConflictInfo, ConflictType } from '../types';

/**
 * Reconnection sync result
 */
export interface ReconnectionSyncResult {
  success: boolean;
  operationsProcessed: number;
  operationsSynced: number;
  operationsFailed: number;
  conflicts: string[];
  errors: string[];
  duration: number;
}

/**
 * Reconnection sync progress
 */
export interface ReconnectionSyncProgress {
  current: number;
  total: number;
  currentOperation: string;
  status: 'syncing' | 'checking-conflicts' | 'complete';
}

/**
 * Service for handling reconnection and syncing offline queue
 */
export class OfflineSyncService {
  private vault: Vault;
  private apiClient: APIClient;
  private eventBus: EventBus;
  private storage: StorageManager;
  private offlineQueue: OfflineQueueService;
  private fileSync: FileSyncService;
  private isSyncing: boolean = false;
  private vaultId: string | null = null;

  constructor(
    vault: Vault,
    apiClient: APIClient,
    eventBus: EventBus,
    storage: StorageManager,
    offlineQueue: OfflineQueueService,
    fileSync: FileSyncService
  ) {
    this.vault = vault;
    this.apiClient = apiClient;
    this.eventBus = eventBus;
    this.storage = storage;
    this.offlineQueue = offlineQueue;
    this.fileSync = fileSync;

    this.setupEventListeners();
  }

  /**
   * Initialize service
   */
  initialize(vaultId: string): void {
    this.vaultId = vaultId;
    console.debug('OfflineSyncService: Initialized for vault', vaultId);
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen for offline mode changes
    this.eventBus.on(EVENTS.OFFLINE_MODE_CHANGED, (offline: boolean) => {
      void (async () => {
        if (!offline) {
          // Connection restored - sync queued operations
          await this.syncQueuedOperations();
        }
      })();
    });
  }

  /**
   * Sync all queued operations after reconnection
   */
  async syncQueuedOperations(): Promise<ReconnectionSyncResult> {
    if (this.isSyncing) {
      console.debug('OfflineSyncService: Already syncing');
      throw new Error('Sync already in progress');
    }

    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    const startTime = Date.now();
    const result: ReconnectionSyncResult = {
      success: true,
      operationsProcessed: 0,
      operationsSynced: 0,
      operationsFailed: 0,
      conflicts: [],
      errors: [],
      duration: 0
    };

    this.isSyncing = true;

    try {
      const queue = this.offlineQueue.getQueue();
      const queuedOps = queue.filter(op => op.status === 'queued');

      if (queuedOps.length === 0) {
        console.debug('OfflineSyncService: No queued operations to sync');
        this.isSyncing = false;
        return result;
      }

      console.debug(`OfflineSyncService: Starting sync of ${queuedOps.length} queued operations`);
      
      // Emit sync started event
      this.eventBus.emit(EVENTS.SYNC_STARTED);

      const totalOps = queuedOps.length;

      for (const operation of queuedOps) {
        try {
          // Emit progress
          this.emitProgress({
            current: result.operationsProcessed + 1,
            total: totalOps,
            currentOperation: `${operation.operation} ${operation.path}`,
            status: 'syncing'
          });

          // Mark as syncing
          await this.offlineQueue.markAsSyncing(operation.id);

          // Check for conflicts before syncing
          const hasConflict = await this.checkForConflict(operation);
          
          if (hasConflict) {
            result.conflicts.push(operation.path);
            await this.offlineQueue.markAsFailed(
              operation.id,
              'Conflict detected - manual resolution required'
            );
            result.operationsFailed++;
            console.debug(`OfflineSyncService: Conflict detected for ${operation.path}`);
          } else {
            // Process the operation
            const syncResult = await this.processOperation(operation);

            if (syncResult.success) {
              await this.offlineQueue.markAsSynced(operation.id);
              result.operationsSynced++;
              console.debug(`OfflineSyncService: Successfully synced ${operation.path}`);
            } else {
              await this.offlineQueue.markAsFailed(operation.id, syncResult.error || 'Unknown error');
              result.operationsFailed++;
              result.errors.push(`${operation.path}: ${syncResult.error}`);
              console.error(`OfflineSyncService: Failed to sync ${operation.path}:`, syncResult.error);
            }
          }

          result.operationsProcessed++;

        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          await this.offlineQueue.markAsFailed(operation.id, errorMessage);
          result.operationsFailed++;
          result.errors.push(`${operation.path}: ${errorMessage}`);
          console.error(`OfflineSyncService: Error processing ${operation.path}:`, error);
        }
      }

      result.success = result.operationsFailed === 0 && result.conflicts.length === 0;
      result.duration = Date.now() - startTime;

      // Emit completion event
      this.eventBus.emit(EVENTS.SYNC_COMPLETED, result);

      // Show summary notification
      this.showSyncSummary(result);

      console.debug(
        `OfflineSyncService: Sync completed - ` +
        `${result.operationsSynced} synced, ` +
        `${result.operationsFailed} failed, ` +
        `${result.conflicts.length} conflicts`
      );

      return result;

    } catch (error) {
      result.success = false;
      result.duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMessage);
      
      this.eventBus.emit(EVENTS.SYNC_ERROR, error);
      console.error('OfflineSyncService: Sync failed:', error);
      
      return result;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Check for conflicts before syncing operation
   */
  private async checkForConflict(operation: OfflineOperation): Promise<boolean> {
    if (!this.vaultId) {
      return false;
    }

    try {
      // For delete operations, no conflict check needed
      if (operation.operation === 'delete') {
        return false;
      }

      // Get remote file info
      const remoteFile = await this.apiClient.getFileByPath(this.vaultId, operation.path);
      
      if (!remoteFile) {
        // File doesn't exist remotely - no conflict
        return false;
      }

      // Check if remote file was modified after operation was queued
      const remoteModified = new Date(remoteFile.updated_at).getTime();
      const operationTime = operation.timestamp;

      if (remoteModified > operationTime) {
        // Remote file was modified after this operation - potential conflict
        console.debug(
          `OfflineSyncService: Potential conflict for ${operation.path} - ` +
          `remote modified at ${new Date(remoteModified).toISOString()}, ` +
          `operation queued at ${new Date(operationTime).toISOString()}`
        );

        // Store conflict information
        await this.storeConflict(operation, remoteFile);
        
        return true;
      }

      return false;

    } catch (error) {
      // If file doesn't exist remotely, no conflict
      if (error instanceof Error && error.message.includes('404')) {
        return false;
      }
      
      console.error('OfflineSyncService: Error checking for conflict:', error);
      // On error, assume no conflict to allow sync attempt
      return false;
    }
  }

  /**
   * Store conflict information
   */
  private async storeConflict(operation: OfflineOperation, remoteFile: FileContent): Promise<void> {
    try {
      const conflicts = await this.storage.get<ConflictInfo[]>('conflicts') || [];

      conflicts.push({
        id: `conflict_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        path: operation.path,
        localContent: operation.content || '',
        remoteContent: remoteFile.content || '',
        localModified: new Date(operation.timestamp),
        remoteModified: new Date(remoteFile.updated_at),
        conflictType: ConflictType.CONTENT,
        autoResolvable: false
      });

      await this.storage.set('conflicts', conflicts);

      // Emit conflict event
      this.eventBus.emit(EVENTS.CONFLICT_DETECTED, {
        path: operation.path,
        conflictId: conflicts[conflicts.length - 1].id,
        source: 'offline-sync'
      });

      console.debug(`OfflineSyncService: Conflict stored for ${operation.path}`);
    } catch (error) {
      console.error('OfflineSyncService: Error storing conflict:', error);
    }
  }

  /**
   * Process a single operation
   */
  private async processOperation(operation: OfflineOperation): Promise<{ success: boolean; error?: string }> {
    try {
      switch (operation.operation) {
        case 'create':
        case 'update':
          return await this.processCreateOrUpdate(operation);
        
        case 'delete':
          return await this.processDelete(operation);
        
        case 'rename':
          return await this.processRename(operation);
        
        default:
          return {
            success: false,
            error: `Unknown operation type: ${operation.operation}`
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Process create or update operation
   */
  private async processCreateOrUpdate(operation: OfflineOperation): Promise<{ success: boolean; error?: string }> {
    try {
      const file = this.vault.getAbstractFileByPath(operation.path);
      
      if (!(file instanceof TFile)) {
        return {
          success: false,
          error: 'File not found in vault'
        };
      }

      // Upload the file
      const result = await this.fileSync.uploadFile(file);
      
      return {
        success: result.success,
        error: result.error
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Process delete operation
   */
  private async processDelete(operation: OfflineOperation): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.vaultId) {
        return { success: false, error: 'Vault not initialized' };
      }

      // Get file info to get file ID
      const fileInfo = await this.apiClient.getFileByPath(this.vaultId, operation.path);
      
      // Delete the file remotely
      await this.apiClient.deleteFile(this.vaultId, fileInfo.file_id);
      
      return { success: true };
    } catch (error) {
      // If file doesn't exist, consider it a success (already deleted)
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('404') || errorMessage.includes('not found')) {
        return { success: true };
      }
      
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Process rename operation
   */
  private async processRename(operation: OfflineOperation): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.vaultId) {
        return { success: false, error: 'Vault not initialized' };
      }

      if (!operation.oldPath) {
        return { success: false, error: 'Old path not specified for rename operation' };
      }

      // Get old file info to get file ID
      try {
        const oldFileInfo = await this.apiClient.getFileByPath(this.vaultId, operation.oldPath);
        // Delete old file
        await this.apiClient.deleteFile(this.vaultId, oldFileInfo.file_id);
      } catch (error) {
        // If old file doesn't exist, that's okay - continue with creating new file
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes('404') && !errorMessage.includes('not found')) {
          throw error;
        }
      }
      
      const file = this.vault.getAbstractFileByPath(operation.path);
      if (!(file instanceof TFile)) {
        return { success: false, error: 'New file not found in vault' };
      }

      const result = await this.fileSync.uploadFile(file);
      
      return {
        success: result.success,
        error: result.error
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Emit progress event
   */
  private emitProgress(progress: ReconnectionSyncProgress): void {
    this.eventBus.emit(EVENTS.SYNC_PROGRESS, {
      current: progress.current,
      total: progress.total,
      currentFile: progress.currentOperation,
      operation: 'sync'
    });
  }

  /**
   * Show sync summary notification
   */
  private showSyncSummary(result: ReconnectionSyncResult): void {
    let message: string;
    let type: 'success' | 'warning' | 'error';

    if (result.success) {
      message = `Successfully synced ${result.operationsSynced} queued operation(s)`;
      type = 'success';
    } else if (result.conflicts.length > 0) {
      message = `Synced ${result.operationsSynced} operation(s), ${result.conflicts.length} conflict(s) detected`;
      type = 'warning';
    } else {
      message = `Sync completed with ${result.operationsFailed} error(s)`;
      type = 'error';
    }

    this.eventBus.emit('notification:show', {
      message,
      type,
      duration: 5000
    });
  }

  /**
   * Check if currently syncing
   */
  isSyncInProgress(): boolean {
    return this.isSyncing;
  }

  /**
   * Manually trigger sync of queued operations
   */
  async syncNow(): Promise<ReconnectionSyncResult> {
    return await this.syncQueuedOperations();
  }
}
