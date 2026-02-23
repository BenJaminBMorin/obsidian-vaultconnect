import { TFile, Vault } from 'obsidian';
import { APIClient } from '../api/APIClient';
import { EventBus, EVENTS } from '../core/EventBus';
import { StorageManager } from '../core/StorageManager';
import { FileWatcherService, FileChangeEvent } from './FileWatcherService';
import { SyncQueueService, QueuedOperation } from './SyncQueueService';
import { FileSyncService } from './FileSyncService';
import { SelectiveSyncService } from './SelectiveSyncService';
import { FileInfo, ConflictInfo, ConflictType } from '../types';

/**
 * Sync mode
 */
export enum SyncMode {
  SMART_SYNC = 'smart_sync',
  PULL_ALL = 'pull_all',
  PUSH_ALL = 'push_all',
  MANUAL = 'manual'
}

/**
 * Sync configuration
 */
export interface SyncConfig {
  mode: SyncMode;
  autoSync: boolean;
  includedFolders: string[];
  excludedFolders: string[];
  configDir: string;
  debounceDelay: number;
  maxRetries: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  maxConcurrent: number;
}

/**
 * Sync result
 */
export interface SyncResult {
  success: boolean;
  filesProcessed: number;
  filesUploaded: number;
  filesDownloaded: number;
  filesDeleted: number;
  errors: string[];
  duration: number;
}

/**
 * Main sync service that orchestrates file watching, queueing, and syncing
 */
export class SyncService {
  private vault: Vault;
  private apiClient: APIClient;
  private eventBus: EventBus;
  private storage: StorageManager;
  
  private selectiveSyncService: SelectiveSyncService;
  private fileWatcher: FileWatcherService;
  private syncQueue: SyncQueueService;
  private fileSync: FileSyncService;
  
  private config: SyncConfig;
  private vaultId: string | null = null;
  private isRunning: boolean = false;
  private periodicSyncInterval: number | null = null;
  private lastSyncCheck: number = 0;
  private lastSyncTimestamp: Date | null = null; // Track last successful sync for incremental checks

  constructor(
    vault: Vault,
    apiClient: APIClient,
    eventBus: EventBus,
    storage: StorageManager,
    config: SyncConfig,
    fileSync?: FileSyncService
  ) {
    this.vault = vault;
    this.apiClient = apiClient;
    this.eventBus = eventBus;
    this.storage = storage;
    this.config = config;

    // Initialize selective sync service
    this.selectiveSyncService = new SelectiveSyncService(
      eventBus,
      storage,
      {
        includedFolders: config.includedFolders,
        excludedFolders: config.excludedFolders
      },
      config.configDir
    );

    // Initialize sub-services
    this.fileWatcher = new FileWatcherService(
      vault,
      eventBus,
      this.selectiveSyncService,
      {
        debounceDelay: config.debounceDelay
      }
    );

    this.syncQueue = new SyncQueueService(
      eventBus,
      storage,
      {
        maxRetries: config.maxRetries,
        retryDelayMs: config.retryDelayMs,
        maxRetryDelayMs: config.maxRetryDelayMs,
        maxConcurrent: config.maxConcurrent
      }
    );

    // Use shared FileSyncService if provided, otherwise create internal one
    this.fileSync = fileSync || new FileSyncService(
      vault,
      apiClient,
      eventBus,
      storage
    );

    this.setupEventHandlers();
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Handle file changes from watcher
    this.eventBus.on(EVENTS.FILE_SYNCED, (event: FileChangeEvent) => {
      void (async () => {
        // Only auto-sync in smart sync mode with auto-sync enabled
        if (this.config.autoSync && this.config.mode === SyncMode.SMART_SYNC) {
          console.debug(`[SyncService] Processing file change: ${event.action} ${event.path}`);
          await this.handleFileChange(event);
        } else if (this.config.mode === SyncMode.MANUAL) {
          console.debug(`[SyncService] File change detected but manual mode is active: ${event.path}`);
        } else {
          console.debug(`[SyncService] File change ignored: autoSync=${this.config.autoSync}, mode=${this.config.mode}, path=${event.path}`);
        }
      })();
    });

    // Handle sync operations from queue
    this.eventBus.on(EVENTS.SYNC_STARTED, (operation?: QueuedOperation) => {
      void (async () => {
        // Only process if operation is provided (from queue)
        if (operation) {
          await this.processSyncOperation(operation);
        }
      })();
    });
  }

  /**
   * Initialize sync service
   */
  async initialize(
    vaultId: string,
    isCrossTenant: boolean = false,
    permission: 'read' | 'write' | 'admin' = 'admin'
  ): Promise<void> {
    this.vaultId = vaultId;

    // Initialize sub-services
    await this.fileSync.initialize(vaultId, isCrossTenant, permission);
    await this.syncQueue.initialize();

    // Load last sync timestamp from storage
    const storedTimestamp = await this.storage.get<string>(`lastSyncTimestamp:${vaultId}`);
    if (storedTimestamp) {
      this.lastSyncTimestamp = new Date(storedTimestamp);
      console.debug(`[SyncService] Restored last sync timestamp: ${this.lastSyncTimestamp.toISOString()}`);
    }

    console.debug('SyncService initialized for vault:', vaultId, {
      isCrossTenant,
      permission
    });
  }

  /**
   * Start sync service
   */
  start(): void {
    if (this.isRunning) {
      console.warn('SyncService is already running');
      return;
    }

    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    this.isRunning = true;

    // Start file watcher
    this.fileWatcher.start();

    // Start queue processing
    this.syncQueue.startProcessing();

    // Start periodic sync check (every 5 minutes)
    this.startPeriodicSyncCheck();

    console.debug('SyncService started');
    this.eventBus.emit(EVENTS.SYNC_STARTED);
  }

  /**
   * Stop sync service
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    // Stop file watcher
    this.fileWatcher.stop();

    // Stop queue processing
    this.syncQueue.stopProcessing();

    // Stop periodic sync check
    this.stopPeriodicSyncCheck();

    this.isRunning = false;
    console.debug('SyncService stopped');
  }

  /**
   * Handle file change event
   */
  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    try {
      const { file, path, action, oldPath } = event;

      console.debug(`Handling file ${action}: ${path}`);

      // Add to sync queue
      let operation: 'create' | 'update' | 'delete' | 'rename';
      let content: string | undefined;

      switch (action) {
        case 'create':
          operation = 'create';
          content = await this.vault.read(file);
          break;
        
        case 'modify':
          operation = 'update';
          content = await this.vault.read(file);
          break;
        
        case 'delete':
          operation = 'delete';
          break;
        
        case 'rename':
          operation = 'rename';
          content = await this.vault.read(file);
          break;
      }

      await this.syncQueue.enqueue(path, operation, content, oldPath);
    } catch (error) {
      console.error('Error handling file change:', error);
      this.eventBus.emit(EVENTS.SYNC_ERROR, {
        path: event.path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Process sync operation from queue
   */
  private async processSyncOperation(operation: QueuedOperation): Promise<void> {
    if (!operation) {
      console.error('Cannot process sync operation: operation is undefined');
      return;
    }

    try {
      const result = await this.fileSync.processQueuedOperation(operation);

      // Emit result event
      this.eventBus.emit(`sync:operation:${operation.id}:result`, result.success, result.error);

      if (result.success) {
        this.eventBus.emit(EVENTS.SYNC_COMPLETED, result);
      } else {
        this.eventBus.emit(EVENTS.SYNC_ERROR, result);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error processing sync operation:', error);
      
      this.eventBus.emit(`sync:operation:${operation.id}:result`, false, errorMessage);
      this.eventBus.emit(EVENTS.SYNC_ERROR, {
        path: operation.path,
        error: errorMessage
      });
    }
  }

  /**
   * Sync all files (manual sync)
   */
  async syncAll(): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      success: true,
      filesProcessed: 0,
      filesUploaded: 0,
      filesDownloaded: 0,
      filesDeleted: 0,
      errors: [],
      duration: 0
    };

    try {
      console.debug('Starting full sync...');
      this.eventBus.emit(EVENTS.SYNC_STARTED);

      const files = this.vault.getMarkdownFiles();
      
      for (const file of files) {
        if (!this.fileWatcher.shouldSyncFile(file)) {
          continue;
        }

        try {
          const syncResult = await this.fileSync.uploadFile(file);
          result.filesProcessed++;
          
          if (syncResult.success) {
            result.filesUploaded++;
          } else {
            result.errors.push(`${file.path}: ${syncResult.error}`);
          }

          // Emit progress
          this.eventBus.emit(EVENTS.SYNC_PROGRESS, {
            current: result.filesProcessed,
            total: files.length,
            currentFile: file.path,
            operation: 'upload'
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.errors.push(`${file.path}: ${errorMessage}`);
        }
      }

      result.success = result.errors.length === 0;
      result.duration = Date.now() - startTime;

      console.debug(`Full sync completed: ${result.filesUploaded} uploaded, ${result.errors.length} errors`);
      this.eventBus.emit(EVENTS.SYNC_COMPLETED, result);

      return result;
    } catch (error) {
      result.success = false;
      result.duration = Date.now() - startTime;
      result.errors.push(error instanceof Error ? error.message : String(error));
      
      this.eventBus.emit(EVENTS.SYNC_ERROR, error);
      return result;
    }
  }

  /**
   * Smart Sync: Bidirectional sync with conflict detection
   */
  async smartSync(): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      success: true,
      filesProcessed: 0,
      filesUploaded: 0,
      filesDownloaded: 0,
      filesDeleted: 0,
      errors: [],
      duration: 0
    };

    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    try {
      console.debug('[VaultSync] Starting smart sync for vault:', this.vaultId);
      this.eventBus.emit(EVENTS.SYNC_STARTED);

      // Get all remote files
      console.debug('[VaultSync] Fetching files from vault:', this.vaultId);
      const remoteFiles = await this.apiClient.listFiles(this.vaultId);
      console.debug(`[VaultSync] Retrieved ${remoteFiles.length} files from vault ${this.vaultId}`);
      const remoteFileMap = new Map(remoteFiles.map(f => [f.path, f]));

      // Get all local files
      const localFiles = this.vault.getMarkdownFiles();
      const localFileMap = new Map(localFiles.map(f => [f.path, f]));

      const totalFiles = Math.max(localFiles.length, remoteFiles.length);
      let processed = 0;

      // Process local files
      for (const localFile of localFiles) {
        if (!this.fileWatcher.shouldSyncFile(localFile)) {
          continue;
        }

        try {
          const remoteFile = remoteFileMap.get(localFile.path);
          
          if (!remoteFile) {
            // File only exists locally - upload it
            const syncResult = await this.fileSync.uploadFile(localFile);
            if (syncResult.success) {
              result.filesUploaded++;
            } else {
              result.errors.push(`${localFile.path}: ${syncResult.error}`);
            }
          } else {
            // File exists both locally and remotely - check for conflicts
            const hasLocalChanges = await this.fileSync.hasLocalChanges(localFile);
            const hasRemoteChanges = await this.fileSync.hasRemoteChanges(localFile.path);

            if (hasLocalChanges && hasRemoteChanges) {
              // Conflict detected - queue for manual resolution
              console.debug(`Conflict detected: ${localFile.path}`);
              await this.handleConflict(localFile, remoteFile);
              result.errors.push(`${localFile.path}: Conflict detected`);
            } else if (hasLocalChanges) {
              // Only local changes - upload
              const syncResult = await this.fileSync.uploadFile(localFile);
              if (syncResult.success) {
                result.filesUploaded++;
              } else {
                result.errors.push(`${localFile.path}: ${syncResult.error}`);
              }
            } else if (hasRemoteChanges) {
              // Only remote changes - download
              const syncResult = await this.fileSync.downloadFile(localFile.path);
              if (syncResult.success) {
                result.filesDownloaded++;
              } else {
                result.errors.push(`${localFile.path}: ${syncResult.error}`);
              }
            }
            // else: no changes on either side - skip
          }

          result.filesProcessed++;
          processed++;

          // Emit progress
          this.eventBus.emit(EVENTS.SYNC_PROGRESS, {
            current: processed,
            total: totalFiles,
            currentFile: localFile.path,
            operation: 'check'
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.errors.push(`${localFile.path}: ${errorMessage}`);
        }
      }

      // Process remote files that don't exist locally
      // Sort by path depth to ensure parent folders are created before children
      const remoteOnlyFiles = remoteFiles
        .filter(f => !localFileMap.has(f.path))
        .sort((a, b) => {
          const depthA = a.path.split('/').length;
          const depthB = b.path.split('/').length;
          return depthA - depthB; // Shallower paths first
        });
      
      for (const remoteFile of remoteOnlyFiles) {
        try {
          // Skip if file was locally deleted (user intentionally deleted it)
          if (this.fileSync.isLocallyDeleted(remoteFile.path)) {
            console.debug(`Skipping download of ${remoteFile.path} - was locally deleted`);
            result.filesProcessed++;
            processed++;
            continue;
          }
          
          // File only exists remotely - download it
          const syncResult = await this.fileSync.downloadFile(remoteFile.path);
          if (syncResult.success) {
            result.filesDownloaded++;
          } else {
            result.errors.push(`${remoteFile.path}: ${syncResult.error}`);
          }

          result.filesProcessed++;
          processed++;

          // Emit progress
          this.eventBus.emit(EVENTS.SYNC_PROGRESS, {
            current: processed,
            total: totalFiles,
            currentFile: remoteFile.path,
            operation: 'download'
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.errors.push(`${remoteFile.path}: ${errorMessage}`);
        }
      }

      result.success = result.errors.length === 0;
      result.duration = Date.now() - startTime;

      console.debug(`Smart sync completed: ${result.filesUploaded} uploaded, ${result.filesDownloaded} downloaded, ${result.errors.length} errors`);
      this.eventBus.emit(EVENTS.SYNC_COMPLETED, result);

      return result;
    } catch (error) {
      result.success = false;
      result.duration = Date.now() - startTime;
      result.errors.push(error instanceof Error ? error.message : String(error));
      
      this.eventBus.emit(EVENTS.SYNC_ERROR, error);
      return result;
    }
  }

  /**
   * Handle conflict by creating a conflict record
   */
  private async handleConflict(localFile: TFile, remoteFile: FileInfo): Promise<void> {
    try {
      const localContent = await this.vault.read(localFile);
      const remoteContent = await this.apiClient.getFileByPath(this.vaultId!, localFile.path);

      // Store conflict information
      const conflicts = await this.storage.get<ConflictInfo[]>('conflicts') || [];
      conflicts.push({
        id: `conflict_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        path: localFile.path,
        localContent,
        remoteContent: remoteContent.content,
        localModified: new Date(localFile.stat.mtime),
        remoteModified: remoteFile.updated_at,
        conflictType: ConflictType.CONTENT,
        autoResolvable: false
      });

      await this.storage.set('conflicts', conflicts);

      // Emit conflict event
      this.eventBus.emit(EVENTS.CONFLICT_DETECTED, {
        path: localFile.path,
        conflictId: conflicts[conflicts.length - 1].id
      });

      console.debug(`Conflict stored for ${localFile.path}`);
    } catch (error) {
      console.error('Error handling conflict:', error);
    }
  }

  /**
   * Pull All: Download all remote files, create conflict copies for differences
   */
  async pullAll(): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      success: true,
      filesProcessed: 0,
      filesUploaded: 0,
      filesDownloaded: 0,
      filesDeleted: 0,
      errors: [],
      duration: 0
    };

    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    try {
      console.debug('[VaultSync] Starting pull all for vault:', this.vaultId);
      this.eventBus.emit(EVENTS.SYNC_STARTED);

      // Get all remote files
      console.debug('[VaultSync] Fetching files from vault:', this.vaultId);
      const remoteFiles = await this.apiClient.listFiles(this.vaultId);
      console.debug(`[VaultSync] Retrieved ${remoteFiles.length} files from vault ${this.vaultId}`);
      const totalFiles = remoteFiles.length;

      for (const remoteFile of remoteFiles) {
        try {
          const localFile = this.vault.getAbstractFileByPath(remoteFile.path);

          if (localFile instanceof TFile) {
            // File exists locally - check for differences
            const localContent = await this.vault.read(localFile);
            const localHash = await this.fileSync.computeHash(localContent);

            if (localHash !== remoteFile.hash) {
              // Content differs - create conflict copy
              const conflictPath = this.generateConflictPath(remoteFile.path);
              await this.vault.create(conflictPath, localContent);
              console.debug(`Created conflict copy: ${conflictPath}`);

              // Download remote version
              const syncResult = await this.fileSync.downloadFile(remoteFile.path);
              if (syncResult.success) {
                result.filesDownloaded++;
              } else {
                result.errors.push(`${remoteFile.path}: ${syncResult.error}`);
              }
            }
            // else: content is the same, skip
          } else {
            // File doesn't exist locally - check if it was intentionally deleted
            if (this.fileSync.isLocallyDeleted(remoteFile.path)) {
              console.debug(`Skipping download of ${remoteFile.path} - was locally deleted`);
            } else {
              // Download it
              const syncResult = await this.fileSync.downloadFile(remoteFile.path);
              if (syncResult.success) {
                result.filesDownloaded++;
              } else {
                result.errors.push(`${remoteFile.path}: ${syncResult.error}`);
              }
            }
          }

          result.filesProcessed++;

          // Emit progress
          this.eventBus.emit(EVENTS.SYNC_PROGRESS, {
            current: result.filesProcessed,
            total: totalFiles,
            currentFile: remoteFile.path,
            operation: 'download'
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.errors.push(`${remoteFile.path}: ${errorMessage}`);
        }
      }

      result.success = result.errors.length === 0;
      result.duration = Date.now() - startTime;

      console.debug(`Pull all completed: ${result.filesDownloaded} downloaded, ${result.errors.length} errors`);
      this.eventBus.emit(EVENTS.SYNC_COMPLETED, result);

      return result;
    } catch (error) {
      result.success = false;
      result.duration = Date.now() - startTime;
      result.errors.push(error instanceof Error ? error.message : String(error));
      
      this.eventBus.emit(EVENTS.SYNC_ERROR, error);
      return result;
    }
  }

  /**
   * Push All: Upload all local files, overwrite remote versions
   */
  async pushAll(options?: { confirmOverwrite?: boolean }): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      success: true,
      filesProcessed: 0,
      filesUploaded: 0,
      filesDownloaded: 0,
      filesDeleted: 0,
      errors: [],
      duration: 0
    };

    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    try {
      console.debug('Starting push all...');
      this.eventBus.emit(EVENTS.SYNC_STARTED);

      // Get all local files
      const localFiles = this.vault.getMarkdownFiles();
      const totalFiles = localFiles.length;

      for (const localFile of localFiles) {
        if (!this.fileWatcher.shouldSyncFile(localFile)) {
          continue;
        }

        try {
          // Upload file (will overwrite remote version)
          const syncResult = await this.fileSync.uploadFile(localFile);
          
          if (syncResult.success) {
            result.filesUploaded++;
          } else {
            result.errors.push(`${localFile.path}: ${syncResult.error}`);
          }

          result.filesProcessed++;

          // Emit progress
          this.eventBus.emit(EVENTS.SYNC_PROGRESS, {
            current: result.filesProcessed,
            total: totalFiles,
            currentFile: localFile.path,
            operation: 'upload'
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.errors.push(`${localFile.path}: ${errorMessage}`);
        }
      }

      result.success = result.errors.length === 0;
      result.duration = Date.now() - startTime;

      console.debug(`Push all completed: ${result.filesUploaded} uploaded, ${result.errors.length} errors`);
      this.eventBus.emit(EVENTS.SYNC_COMPLETED, result);

      return result;
    } catch (error) {
      result.success = false;
      result.duration = Date.now() - startTime;
      result.errors.push(error instanceof Error ? error.message : String(error));
      
      this.eventBus.emit(EVENTS.SYNC_ERROR, error);
      return result;
    }
  }

  /**
   * Force Sync: Sync all files regardless of change detection
   */
  async forceSync(): Promise<SyncResult> {
    console.debug('Force sync - clearing sync state and syncing all files');
    
    // Clear sync state to force re-sync
    await this.fileSync.clearAllSyncState();
    
    // Perform sync based on current mode
    switch (this.config.mode) {
      case SyncMode.SMART_SYNC:
        return await this.smartSync();
      case SyncMode.PULL_ALL:
        return await this.pullAll();
      case SyncMode.PUSH_ALL:
        return await this.pushAll();
      default:
        return await this.syncAll();
    }
  }

  /**
   * Generate conflict copy path
   */
  private generateConflictPath(originalPath: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const parts = originalPath.split('.');
    const ext = parts.pop();
    const base = parts.join('.');
    return `${base}.conflict-${timestamp}.${ext}`;
  }

  /**
   * Update sync configuration
   */
  updateConfig(config: Partial<SyncConfig>): void {
    const oldMode = this.config.mode;
    this.config = { ...this.config, ...config };

    // Update selective sync config
    if (config.includedFolders !== undefined || config.excludedFolders !== undefined) {
      this.selectiveSyncService.updateConfig({
        includedFolders: this.config.includedFolders,
        excludedFolders: this.config.excludedFolders
      });
    }

    // Update file watcher config
    if (config.debounceDelay !== undefined) {
      this.fileWatcher.updateConfig({
        debounceDelay: this.config.debounceDelay
      });
    }

    // Handle mode changes
    if (config.mode !== undefined && config.mode !== oldMode) {
      this.handleModeChange(oldMode, config.mode);
    }
  }

  /**
   * Handle sync mode change
   */
  private handleModeChange(oldMode: SyncMode, newMode: SyncMode): void {
    console.debug(`Sync mode changed from ${oldMode} to ${newMode}`);

    // If switching to manual mode, disable auto-sync
    if (newMode === SyncMode.MANUAL) {
      this.config.autoSync = false;
      console.debug('Auto-sync disabled for manual mode');
    }

    // If switching from manual mode to another mode, may want to enable auto-sync
    if (oldMode === SyncMode.MANUAL && newMode === SyncMode.SMART_SYNC) {
      console.debug('Consider enabling auto-sync for smart sync mode');
    }

    this.eventBus.emit(EVENTS.SYNC_MODE_CHANGED, { oldMode, newMode });
  }

  /**
   * Set sync mode
   */
  setSyncMode(mode: SyncMode): void {
    this.updateConfig({ mode });
  }

  /**
   * Get current sync mode
   */
  getSyncMode(): SyncMode {
    return this.config.mode;
  }

  /**
   * Enable auto-sync
   */
  enableAutoSync(): void {
    if (this.config.mode === SyncMode.MANUAL) {
      console.warn('Cannot enable auto-sync in manual mode');
      return;
    }
    this.updateConfig({ autoSync: true });
  }

  /**
   * Disable auto-sync
   */
  disableAutoSync(): void {
    this.updateConfig({ autoSync: false });
  }

  /**
   * Check if auto-sync is enabled
   */
  isAutoSyncEnabled(): boolean {
    return this.config.autoSync && this.config.mode !== SyncMode.MANUAL;
  }

  /**
   * Get sync configuration
   */
  getConfig(): SyncConfig {
    return { ...this.config };
  }

  /**
   * Get sync statistics
   */
  getSyncStatistics() {
    return {
      ...this.fileSync.getSyncStatistics(),
      queue: this.syncQueue.getQueueStats(),
      isRunning: this.isRunning
    };
  }

  /**
   * Get queue
   */
  getQueue(): QueuedOperation[] {
    return this.syncQueue.getQueue();
  }

  /**
   * Clear queue
   */
  async clearQueue(): Promise<void> {
    await this.syncQueue.clearQueue();
  }

  /**
   * Retry failed operations
   */
  async retryFailed(): Promise<void> {
    await this.syncQueue.retryFailed();
  }

  /**
   * Check if service is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get selective sync service
   */
  getSelectiveSyncService(): SelectiveSyncService {
    return this.selectiveSyncService;
  }

  /**
   * Set included folders for selective sync
   */
  setIncludedFolders(folders: string[]): void {
    this.config.includedFolders = folders;
    this.selectiveSyncService.setIncludedFolders(folders);
  }

  /**
   * Set excluded folders for selective sync
   */
  setExcludedFolders(folders: string[]): void {
    this.config.excludedFolders = folders;
    this.selectiveSyncService.setExcludedFolders(folders);
  }

  /**
   * Get sync scope preview
   */
  getSyncScopePreview() {
    const files = this.vault.getMarkdownFiles();
    return this.selectiveSyncService.getSyncScopePreview(files);
  }

  /**
   * Forward file create event to FileWatcherService
   */
  handleFileCreate(file: TFile): void {
    this.fileWatcher.handleCreate(file);
  }

  /**
   * Forward file modify event to FileWatcherService
   */
  handleFileModify(file: TFile): void {
    this.fileWatcher.handleModify(file);
  }

  /**
   * Forward file delete event to FileWatcherService
   */
  handleFileDelete(file: TFile): void {
    this.fileWatcher.handleDelete(file);
  }

  /**
   * Forward file rename event to FileWatcherService
   */
  handleFileRename(file: TFile, oldPath: string): void {
    this.fileWatcher.handleRename(file, oldPath);
  }

  /**
   * Temporarily ignore a file path (to prevent sync loops during downloads)
   */
  ignorePath(path: string): void {
    this.fileWatcher.ignorePath(path);
  }

  /**
   * Stop ignoring a file path
   */
  unignorePath(path: string): void {
    this.fileWatcher.unignorePath(path);
  }

  /**
   * Start periodic sync check to ensure we stay in sync
   */
  private startPeriodicSyncCheck(): void {
    // Check every 2 minutes for near-live sync performance
    const intervalMs = 2 * 60 * 1000;

    this.periodicSyncInterval = window.setInterval(() => {
      void (async () => {
        if (!this.isRunning || !this.vaultId) {
          return;
        }

        const now = Date.now();
        const timeSinceLastCheck = now - this.lastSyncCheck;

        // Only run if it's been at least 90 seconds since last check
        // (to avoid overlapping checks)
        if (timeSinceLastCheck < 90 * 1000) {
          return;
        }

        console.debug('[SyncService] Running periodic sync check...');
        this.lastSyncCheck = now;

        try {
          await this.performSyncCheck();
        } catch (error) {
          console.error('[SyncService] Periodic sync check failed:', error);
        }
      })();
    }, intervalMs);

    console.debug('[SyncService] Periodic sync check started (every 2 minutes)');
  }

  /**
   * Stop periodic sync check
   */
  private stopPeriodicSyncCheck(): void {
    if (this.periodicSyncInterval !== null) {
      window.clearInterval(this.periodicSyncInterval);
      this.periodicSyncInterval = null;
      console.debug('[SyncService] Periodic sync check stopped');
    }
  }

  /**
   * Perform an optimized sync check using incremental change detection
   * Only fetches files that changed since last check - much more efficient!
   */
  private async performSyncCheck(): Promise<void> {
    if (!this.vaultId) {
      return;
    }

    try {
      // Use incremental sync if we have a last sync timestamp
      // Otherwise, fall back to full check (first time)
      if (this.lastSyncTimestamp) {
        console.debug(`[SyncCheck] Using incremental check since ${this.lastSyncTimestamp.toISOString()}`);
        await this.performIncrementalCheck();
      } else {
        console.debug('[SyncCheck] No last sync timestamp - performing initial full check');
        await this.performFullCheck();
      }

      // Update last sync timestamp on successful check
      this.lastSyncTimestamp = new Date();

      // Persist timestamp for recovery after restart
      await this.storage.set(`lastSyncTimestamp:${this.vaultId}`, this.lastSyncTimestamp.toISOString());

    } catch (error) {
      console.error('[SyncCheck] Error during sync check:', error);
    }
  }

  /**
   * Perform incremental check - only checks files changed since last sync
   * This is 99% more efficient for typical usage!
   */
  private async performIncrementalCheck(): Promise<void> {
    if (!this.vaultId || !this.lastSyncTimestamp) {
      return;
    }

    // Fetch only files that changed since last sync - much faster!
    const changedFiles = await this.apiClient.getChangedFiles(this.vaultId, this.lastSyncTimestamp);

    if (changedFiles.length === 0) {
      console.debug('[SyncCheck] ✓ No remote changes detected');
      return;
    }

    console.debug(`[SyncCheck] 📥 Found ${changedFiles.length} changed file(s) on remote`, {
      files: changedFiles.map(f => f.path).slice(0, 5),
      ...(changedFiles.length > 5 && { more: `... and ${changedFiles.length - 5} more` })
    });

    // Check each changed file against local
    const driftedFiles: string[] = [];
    for (const remoteFile of changedFiles) {
      const localFile = this.vault.getAbstractFileByPath(remoteFile.path);

      if (!localFile) {
        // Remote file doesn't exist locally - needs download
        driftedFiles.push(remoteFile.path);
      } else if (localFile instanceof TFile) {
        // Check if hashes match
        const storedHash = this.fileSync.getStoredHash(remoteFile.path);
        if (storedHash !== remoteFile.hash) {
          driftedFiles.push(remoteFile.path);
        }
      }
    }

    if (driftedFiles.length > 0) {
      console.warn(`[SyncCheck] ⚠️  ${driftedFiles.length} file(s) need sync`, {
        files: driftedFiles.slice(0, 10)
      });

      this.eventBus.emit(EVENTS.SYNC_DRIFT_DETECTED, {
        driftCount: driftedFiles.length,
        files: driftedFiles
      });

      // Auto-trigger sync
      if (this.config.mode === SyncMode.SMART_SYNC && this.config.autoSync) {
        console.debug('[SyncCheck] Auto-triggering smart sync...');
        await this.smartSync();
      }
    } else {
      console.debug('[SyncCheck] ✓ All changed files already in sync');
    }
  }

  /**
   * Perform full check - used on first sync or when incremental data unavailable
   * This is the old behavior - checks all files
   */
  private async performFullCheck(): Promise<void> {
    if (!this.vaultId) {
      return;
    }

    // Get remote file list (all files)
    const remoteFiles = await this.apiClient.listFiles(this.vaultId);
    const remoteFileMap = new Map(remoteFiles.map(f => [f.path, f]));

    // Get local files
    const localFiles = this.vault.getMarkdownFiles();
    const syncableLocalFiles = localFiles.filter(f => this.fileWatcher.shouldSyncFile(f));

    let needsSync = false;
    let driftCount = 0;
    const driftedFiles: string[] = [];

    console.debug(`[SyncCheck] Full check: ${syncableLocalFiles.length} local vs ${remoteFiles.length} remote`);

    // Check local files against remote
    for (const localFile of syncableLocalFiles) {
      const remoteFile = remoteFileMap.get(localFile.path);

      if (!remoteFile) {
        needsSync = true;
        driftCount++;
        driftedFiles.push(localFile.path);
      } else {
        const storedHash = this.fileSync.getStoredHash(localFile.path);
        if (storedHash && storedHash !== remoteFile.hash) {
          needsSync = true;
          driftCount++;
          driftedFiles.push(localFile.path);
        }
      }
    }

    // Check for remote files not present locally
    for (const remoteFile of remoteFiles) {
      const localFile = this.vault.getAbstractFileByPath(remoteFile.path);
      if (!localFile) {
        needsSync = true;
        driftCount++;
        driftedFiles.push(remoteFile.path);
      }
    }

    if (needsSync) {
      console.warn(`[SyncCheck] ⚠️  Initial drift: ${driftCount} file(s) need sync`);
      this.eventBus.emit(EVENTS.SYNC_DRIFT_DETECTED, { driftCount, files: driftedFiles });

      if (this.config.mode === SyncMode.SMART_SYNC && this.config.autoSync) {
        console.debug('[SyncCheck] Auto-triggering initial smart sync...');
        await this.smartSync();
      }
    } else {
      console.debug('[SyncCheck] ✓ Initial check complete - all files in sync');
    }
  }

  /**
   * Handle reconnection - perform immediate sync check
   */
  async handleReconnection(): Promise<void> {
    console.debug('[SyncService] Handling reconnection, performing sync check...');
    this.lastSyncCheck = Date.now();
    
    try {
      await this.performSyncCheck();
    } catch (error) {
      console.error('[SyncService] Reconnection sync check failed:', error);
    }
  }
}
