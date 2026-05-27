import { Notice, TFile, Vault } from 'obsidian';
import { APIClient } from '../api/APIClient';
import { EventBus, EVENTS } from '../core/EventBus';
import { StorageManager } from '../core/StorageManager';
import { FileWatcherService, FileChangeEvent } from './FileWatcherService';
import { SyncQueueService, QueuedOperation } from './SyncQueueService';
import { FileSyncService } from './FileSyncService';
import { SelectiveSyncService } from './SelectiveSyncService';
import { ConflictService } from './ConflictService';
import { ConflictInfo, FileInfo } from '../types';

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
  private conflictService: ConflictService | null = null;

  private config: SyncConfig;
  private vaultId: string | null = null;
  private isRunning: boolean = false;
  private isSyncing: boolean = false;
  private periodicSyncInterval: number | null = null;
  private lastSyncCheck: number = 0;
  private lastSyncTimestamp: Date | null = null; // Track last successful sync for incremental checks
  private incrementalCheckCount: number = 0; // Counter for periodic full sync

  // Server-side deletion cache. Populated whenever we fetch /deletions; consulted
  // before any upload to avoid restoring a file that was deleted on another device
  // while this client was offline. Maps path → tombstone time (ms epoch).
  private serverFileTombstones: Map<string, number> = new Map();
  private serverFolderTombstones: Array<{ path: string; deletedAt: number }> = [];
  private tombstonesRefreshedAt: number = 0;

  // Visibility/resume handling — mobile Obsidian suspends JS in the background, so
  // setInterval doesn't fire while the app is backgrounded. We listen for
  // visibilitychange and trigger a sync check on resume so the user doesn't have
  // to wait up to 2 minutes (or hit force-sync) to see remote changes.
  private visibilityListener: (() => void) | null = null;
  private lastVisibilityResumeAt: number = 0;

  // Per-path download-failure counters used by drainPendingDownloads to decide
  // when to notify the user that a path is stuck. Reset to 0 on success.
  private downloadFailureCounts: Map<string, number> = new Map();
  private notifiedStuckPaths: Set<string> = new Set();

  // Persistent device ID (same one APIClient sends as X-Device-Id). Used for
  // the per-device inventory ack endpoint so the server can tell us what we
  // claim to have vs what we should have.
  private deviceId: string | null = null;

  // Store unsubscribe functions for event listeners so they can be cleaned up
  private eventUnsubscribers: Array<() => void> = [];

  constructor(
    vault: Vault,
    apiClient: APIClient,
    eventBus: EventBus,
    storage: StorageManager,
    config: SyncConfig,
    fileSync?: FileSyncService,
    conflictService?: ConflictService
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

    this.conflictService = conflictService || null;

    // Wire up ignore path callbacks so downloads don't trigger re-upload sync loops
    this.fileSync.setIgnorePathCallbacks(
      (path: string) => this.fileWatcher.ignorePath(path),
      (path: string) => this.fileWatcher.unignorePath(path)
    );

    this.setupEventHandlers();
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Handle file changes from watcher
    const unsubFileSynced = this.eventBus.on(EVENTS.FILE_SYNCED, (event: FileChangeEvent) => {
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
    this.eventUnsubscribers.push(unsubFileSynced);

    // Handle sync operations from queue
    const unsubSyncStarted = this.eventBus.on(EVENTS.SYNC_STARTED, (operation?: QueuedOperation) => {
      void (async () => {
        // Only process if operation is provided (from queue)
        if (operation) {
          await this.processSyncOperation(operation);
        }
      })();
    });
    this.eventUnsubscribers.push(unsubSyncStarted);
  }

  /**
   * Set the persistent device ID for inventory acks. Plumbed in by main.ts
   * when the plugin loads — same value used by APIClient for X-Device-Id.
   */
  setDeviceId(deviceId: string): void {
    this.deviceId = deviceId;
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

    // Listen for app visibility changes so we can catch up immediately on mobile
    // resume (where setInterval doesn't fire while backgrounded).
    this.setupVisibilityListener();

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

    this.teardownVisibilityListener();

    this.isRunning = false;
    console.debug('SyncService stopped');
  }

  /**
   * Destroy the service, removing all event listeners and stopping all timers.
   * Call this from the plugin's onunload() to prevent leaked listeners.
   */
  destroy(): void {
    this.stop();

    // Remove all event bus listeners
    for (const unsub of this.eventUnsubscribers) {
      unsub();
    }
    this.eventUnsubscribers = [];

    console.debug('SyncService destroyed — all listeners removed');
  }

  /**
   * Handle file change event
   */
  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    try {
      const { file, path, action, oldPath } = event;

      console.debug(`Handling file ${action}: ${path}`);

      // For uploads, consult the server-tombstone cache: if this path was deleted
      // remotely after the local file's last modification, the local copy is
      // stale (it pre-dates the deletion) and uploading would resurrect a file
      // the user already deleted. Drop the local file instead of queueing.
      if ((action === 'create' || action === 'modify') && file) {
        await this.refreshTombstones();
        const tombstoneAt = this.getActiveTombstone(path);
        if (tombstoneAt !== null && file.stat.mtime <= tombstoneAt) {
          console.debug(`[SyncService] Suppressing upload of stale local copy (tombstone at ${new Date(tombstoneAt).toISOString()}, mtime ${new Date(file.stat.mtime).toISOString()}): ${path}`);
          try {
            await this.vault.delete(file);
            this.fileSync.addLocallyDeleted(path);
          } catch (deleteErr) {
            console.warn(`[SyncService] Failed to delete stale local copy ${path}:`, deleteErr);
          }
          return;
        }
      }

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

      const files = this.vault.getFiles();

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
    // Prevent concurrent smartSync runs (periodic timer, manual trigger, drift detection)
    if (this.isSyncing) {
      console.debug('[VaultSync] smartSync already in progress, skipping');
      return {
        success: true,
        filesProcessed: 0,
        filesUploaded: 0,
        filesDownloaded: 0,
        filesDeleted: 0,
        errors: [],
        duration: 0
      };
    }

    this.isSyncing = true;
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
      this.isSyncing = false;
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

      // Fetch server-side deletions to prevent re-uploading deleted files.
      // Use lastSyncTimestamp if available, otherwise look back 30 days (covers force sync).
      const serverDeletedPaths = new Set<string>();
      const serverDeletedFolders: string[] = [];
      try {
        const since = this.lastSyncTimestamp || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const deletions = await this.apiClient.getDeletedFiles(this.vaultId, since);
        for (const d of deletions) {
          if (d.is_folder) {
            serverDeletedFolders.push(d.file_path);
          } else {
            serverDeletedPaths.add(d.file_path);
          }
        }
        if (serverDeletedPaths.size > 0 || serverDeletedFolders.length > 0) {
          console.debug(`[VaultSync] ${serverDeletedPaths.size} file deletion(s), ${serverDeletedFolders.length} folder deletion(s) since ${since.toISOString()}`);
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.warn(`[VaultSync] Could not fetch server deletions: ${errMsg}`);
      }

      // Get all local files (including binary — getMarkdownFiles() only returns .md)
      const localFiles = this.vault.getFiles();
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
            // File only exists locally — check if it was deleted on the server
            // Check both exact file tombstones AND folder tombstones (prefix match)
            const isFileDeleted = serverDeletedPaths.has(localFile.path);
            const isFolderDeleted = serverDeletedFolders.some(folder => localFile.path.startsWith(folder));

            if (isFileDeleted || isFolderDeleted) {
              // Server intentionally deleted this file (or its parent folder) — delete local copy
              console.debug(`[VaultSync] Deleting local file (server-side ${isFolderDeleted ? 'folder' : 'file'} deletion): ${localFile.path}`);
              try {
                await this.vault.delete(localFile);
                this.fileSync.addLocallyDeleted(localFile.path);
                result.filesDeleted++;
              } catch (deleteErr) {
                const msg = deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
                result.errors.push(`${localFile.path}: Failed to delete local copy: ${msg}`);
              }
            } else {
              // Genuinely new local file — upload it
              const syncResult = await this.fileSync.uploadFile(localFile);
              if (syncResult.success) {
                result.filesUploaded++;
              } else {
                result.errors.push(`${localFile.path}: ${syncResult.error}`);
              }
            }
          } else {
            // File exists both locally and remotely - check for conflicts
            const hasLocalChanges = await this.fileSync.hasLocalChanges(localFile);
            const hasRemoteChanges = await this.fileSync.hasRemoteChanges(localFile.path);

            if (hasLocalChanges && hasRemoteChanges) {
              // When there's no stored hash (first time tracking this file, e.g.
              // binary files that were previously excluded by getMarkdownFiles),
              // compare local and remote hashes directly instead of declaring conflict.
              const storedHash = this.fileSync.getStoredHash(localFile.path);
              if (!storedHash) {
                const localHash = await this.fileSync.computeLocalHash(localFile);
                if (localHash === remoteFile.hash) {
                  // Content already matches — adopt the hash, no sync needed
                  console.debug(`Adopting hash for previously untracked file: ${localFile.path}`);
                  this.fileSync.setStoredHash(localFile.path, localHash);
                } else {
                  // Content genuinely differs — download remote version
                  console.debug(`Untracked file differs from remote, downloading: ${localFile.path}`);
                  const syncResult = await this.fileSync.downloadFile(localFile.path);
                  if (syncResult.success) {
                    result.filesDownloaded++;
                  } else {
                    result.errors.push(`${localFile.path}: ${syncResult.error}`);
                  }
                }
              } else {
                // Genuine conflict - both sides changed since last sync
                console.debug(`Conflict detected: ${localFile.path}`);
                await this.handleConflict(localFile, remoteFile);
                result.errors.push(`${localFile.path}: Conflict detected`);
              }
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

      // Prune stale sync state entries for files that no longer exist
      const existingPaths = new Set<string>();
      for (const f of localFiles) existingPaths.add(f.path);
      for (const f of remoteFiles) existingPaths.add(f.path);
      this.fileSync.pruneDeletedFiles(existingPaths);

      // Send our local inventory to the server. Server returns the delta
      // (files we're missing or have at the wrong hash); we add those to
      // the pendingDownloads queue. This is the per-device delivery-ack
      // mechanism that closes the loop on "files exist on server, never
      // made it here" bugs.
      await this.reconcileWithServer().catch(err => {
        console.warn('[SyncService] inventory reconcile failed (non-fatal):', err);
      });

      // Drain whatever is in the pending-downloads queue NOW. Without this,
      // Force Sync (which calls smartSync directly) populates the queue but
      // never drains it — drainPendingDownloads only ran from
      // performSyncCheck on the periodic timer, so the user would have to
      // wait up to 2 minutes (or app foreground) to actually see files. The
      // drain is idempotent and short-circuits when the queue is empty.
      try {
        const drainedClean = await this.drainPendingDownloads();
        if (!drainedClean) {
          const stillPending = this.fileSync.getPendingDownloads();
          console.warn(`[SyncService] smartSync drain incomplete — ${stillPending.length} item(s) still pending; next sync cycle will retry.`);
          // Surface pending-download failures in the result so callers (and
          // the UI) know the sync is not fully clean — previously these were
          // silently swallowed and the result always reported "0 errors".
          for (const p of stillPending) {
            result.errors.push(`Pending download failed: ${p}`);
          }
          result.success = false;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[SyncService] smartSync drain threw (non-fatal):', err);
        result.errors.push(`Download drain error: ${msg}`);
        result.success = false;
      }

      console.debug(`Smart sync completed: ${result.filesUploaded} uploaded, ${result.filesDownloaded} downloaded, ${result.errors.length} errors`);
      this.eventBus.emit(EVENTS.SYNC_COMPLETED, result);

      return result;
    } catch (error) {
      result.success = false;
      result.duration = Date.now() - startTime;
      result.errors.push(error instanceof Error ? error.message : String(error));

      this.eventBus.emit(EVENTS.SYNC_ERROR, error);
      return result;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Handle conflict by delegating to ConflictService (or storing metadata-only)
   */
  private async handleConflict(localFile: TFile, remoteFile: FileInfo): Promise<void> {
    try {
      // Delegate to ConflictService when available (preferred path)
      if (this.conflictService) {
        const remoteModified = remoteFile.updated_at instanceof Date
          ? remoteFile.updated_at
          : new Date(remoteFile.updated_at);
        await this.conflictService.checkFileConflict(localFile, remoteFile.hash, remoteModified);
        return;
      }

      // Fallback: store metadata-only conflict (no full content in data.json)
      const conflicts = await this.storage.get<ConflictInfo[]>('conflicts') || [];

      // Compute actual local hash from file content
      const localContent = await this.vault.read(localFile);
      const localHash = await this.fileSync.computeHash(localContent);

      // Dedup by path
      const deduped = conflicts.filter(c => c.path !== localFile.path);

      deduped.push({
        id: `conflict_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        path: localFile.path,
        localHash,
        remoteHash: remoteFile.hash,
        localModified: new Date(localFile.stat.mtime),
        remoteModified: remoteFile.updated_at instanceof Date
          ? remoteFile.updated_at
          : new Date(remoteFile.updated_at),
        conflictType: 'content' as any,
        autoResolvable: false
      });

      await this.storage.set('conflicts', deduped);

      this.eventBus.emit(EVENTS.CONFLICT_DETECTED, {
        path: localFile.path,
        conflictId: deduped[deduped.length - 1].id
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

      // Refresh server tombstones first so we don't restore files that were
      // deleted on another device while this one was offline.
      await this.refreshTombstones(true);

      // Get all local files (including binary — getMarkdownFiles() only returns .md)
      const localFiles = this.vault.getFiles();
      const totalFiles = localFiles.length;

      for (const localFile of localFiles) {
        if (!this.fileWatcher.shouldSyncFile(localFile)) {
          continue;
        }

        try {
          const tombstoneAt = this.getActiveTombstone(localFile.path);
          if (tombstoneAt !== null && localFile.stat.mtime <= tombstoneAt) {
            console.debug(`[VaultSync] Skipping push for stale local copy (server-deleted): ${localFile.path}`);
            try {
              await this.vault.delete(localFile);
              this.fileSync.addLocallyDeleted(localFile.path);
              result.filesDeleted++;
            } catch (deleteErr) {
              const msg = deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
              result.errors.push(`${localFile.path}: Failed to clear stale local copy: ${msg}`);
            }
            result.filesProcessed++;
            continue;
          }

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

    // Clear sync state to force re-sync (preserves locallyDeletedFiles)
    await this.fileSync.clearAllSyncState();

    // Clear lastSyncTimestamp so smartSync uses the 30-day lookback window
    // for tombstone queries, ensuring ALL recent deletions are honoured.
    this.lastSyncTimestamp = null;

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
    const files = this.vault.getFiles();
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
   * Check if a file has a pending debounce (user is actively editing)
   */
  hasPendingChange(path: string): boolean {
    return this.fileWatcher.hasPendingChange(path);
  }

  /**
   * Listen for the document becoming visible again. On mobile Obsidian, JS is
   * suspended while backgrounded, so the periodic sync interval stops firing
   * and the user sees stale state until the next tick (up to 2 min) or until
   * they hit force-sync. Reacting to visibilitychange closes that window.
   *
   * Rate-limited to once per 30s so quickly toggling apps doesn't hammer the API.
   */
  private setupVisibilityListener(): void {
    if (this.visibilityListener) {
      return;
    }

    this.visibilityListener = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      if (!this.isRunning || !this.vaultId) {
        return;
      }
      const now = Date.now();
      if (now - this.lastVisibilityResumeAt < 30 * 1000) {
        return;
      }
      this.lastVisibilityResumeAt = now;

      console.debug('[SyncService] App resumed — triggering catch-up sync check');
      void (async () => {
        try {
          this.lastSyncCheck = now;
          await this.performSyncCheck();
        } catch (err) {
          console.error('[SyncService] Resume sync check failed:', err);
        }
      })();
    };

    document.addEventListener('visibilitychange', this.visibilityListener);
  }

  private teardownVisibilityListener(): void {
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
  }

  /**
   * Refresh the server-tombstone cache by fetching deletions since the last
   * sync (or 30 days if no last-sync timestamp). Subsequent uploads consult the
   * cache so we don't restore files that were deleted on another device while
   * this client was offline.
   *
   * Cached for 60s — file-event uploads call this lazily so a burst of file
   * changes doesn't generate a fetch per file.
   */
  private async refreshTombstones(force: boolean = false): Promise<void> {
    if (!this.vaultId) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.tombstonesRefreshedAt < 60 * 1000) {
      return;
    }

    const since = this.lastSyncTimestamp || new Date(now - 30 * 24 * 60 * 60 * 1000);
    try {
      const deletions = await this.apiClient.getDeletedFiles(this.vaultId, since);
      const fileMap = new Map<string, number>();
      const folderList: Array<{ path: string; deletedAt: number }> = [];
      for (const d of deletions) {
        const deletedAtMs = new Date(d.deleted_at).getTime();
        if (d.is_folder) {
          folderList.push({ path: d.file_path, deletedAt: deletedAtMs });
        } else {
          fileMap.set(d.file_path, deletedAtMs);
        }
      }
      this.serverFileTombstones = fileMap;
      this.serverFolderTombstones = folderList;
      this.tombstonesRefreshedAt = now;
      if (fileMap.size > 0 || folderList.length > 0) {
        console.debug(`[VaultSync] Refreshed tombstones: ${fileMap.size} file(s), ${folderList.length} folder(s)`);
      }
    } catch (e) {
      console.warn('[VaultSync] Could not refresh server tombstones:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * Returns the tombstone timestamp (ms) if the path (or any parent folder)
   * was deleted server-side, otherwise null. Compare against local file mtime
   * to decide between "stale local copy" (delete locally) and "user re-created
   * the file after the deletion" (allow upload).
   */
  private getActiveTombstone(path: string): number | null {
    const fileTombstone = this.serverFileTombstones.get(path);
    if (fileTombstone !== undefined) {
      return fileTombstone;
    }
    let latestFolder: number | null = null;
    for (const folder of this.serverFolderTombstones) {
      const prefix = folder.path.endsWith('/') ? folder.path : `${folder.path}/`;
      if (path.startsWith(prefix)) {
        if (latestFolder === null || folder.deletedAt > latestFolder) {
          latestFolder = folder.deletedAt;
        }
      }
    }
    return latestFolder;
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
        this.incrementalCheckCount++;

        // Every 15 incremental checks (~30 min), run a full smartSync
        // to catch anything that slipped through (deletions, edge cases)
        if (this.incrementalCheckCount >= 15) {
          console.debug('[SyncCheck] Running periodic full smart sync (every ~30 min)');
          this.incrementalCheckCount = 0;
          if (this.config.mode === SyncMode.SMART_SYNC) {
            await this.smartSync();
          } else {
            await this.performFullCheck();
          }
        } else {
          console.debug(`[SyncCheck] Using incremental check since ${this.lastSyncTimestamp.toISOString()} (${this.incrementalCheckCount}/15)`);
          await this.performIncrementalCheck();
        }
      } else {
        console.debug('[SyncCheck] No last sync timestamp - performing initial full check');
        await this.performFullCheck();
      }

      // Drain any pending downloads from prior cycles. This persistent queue
      // is the durability mechanism for drift: anything we observed but
      // didn't successfully bring local stays here until it does, regardless
      // of process kills, autoSync toggles, or mode changes.
      const drainedClean = await this.drainPendingDownloads();

      // Only advance lastSyncTimestamp if the queue is fully drained. If
      // pending downloads remain, the next check should use the SAME
      // timestamp so it re-detects them via /files/changed instead of
      // skipping past their updated_at.
      if (drainedClean) {
        this.lastSyncTimestamp = new Date();
        await this.storage.set(`lastSyncTimestamp:${this.vaultId}`, this.lastSyncTimestamp.toISOString());
      } else {
        console.warn(`[SyncCheck] ${this.fileSync.getPendingDownloads().length} pending download(s) remain — keeping lastSyncTimestamp unchanged so next check retries them.`);
      }

    } catch (error) {
      console.error('[SyncCheck] Error during sync check:', error);
    }
  }

  /**
   * Send our local file inventory to the server and queue anything the
   * server reports we're missing or have at the wrong hash. Called at the
   * end of smartSync; the next drainPendingDownloads pass picks up the
   * delta and brings local in line with truth.
   *
   * Best-effort: server-side endpoint is graceful-degrade aware; older
   * deploys return null and we just skip the reconcile for that cycle.
   */
  private async reconcileWithServer(): Promise<void> {
    if (!this.vaultId || !this.deviceId) return;

    const localFiles = this.vault.getFiles();
    const inventory: Array<{ path: string; hash: string }> = [];
    for (const f of localFiles) {
      const hash = this.fileSync.getStoredHash(f.path);
      if (hash) {
        inventory.push({ path: f.path, hash });
      }
    }

    const delta = await this.apiClient.reconcileDeviceInventory(
      this.vaultId,
      this.deviceId,
      inventory
    );
    if (!delta) return;

    if (delta.out_of_date.length > 0) {
      console.warn(
        `[SyncService] Server reports ${delta.out_of_date.length} file(s) out of date for this device — queueing for download`,
        { sample: delta.out_of_date.slice(0, 5).map(f => f.path) }
      );
      // Bulk add — single saveSyncState write instead of N (each save is a
      // round-trip to plugin storage which is slow on iOS).
      this.fileSync.addPendingDownloads(delta.out_of_date.map(e => e.path));
    }

    if (delta.unknown_to_server.length > 0) {
      console.warn(
        `[SyncService] ${delta.unknown_to_server.length} local file(s) are unknown to the server. Possible sync-loop bug or unsynced local creates.`,
        { sample: delta.unknown_to_server.slice(0, 5) }
      );
    }

    console.debug('[SyncService] Inventory reconcile complete', delta.counts);
  }

  /**
   * Drain the persistent pending-downloads queue. Returns true iff every
   * pending path was either successfully downloaded or determined to be
   * legitimately gone (404 from server). Returns false if any download
   * failed or the user chose not to restore a locally-deleted path.
   */
  private async drainPendingDownloads(): Promise<boolean> {
    const pending = this.fileSync.getPendingDownloads();
    if (pending.length === 0) {
      return true;
    }

    console.debug(`[SyncCheck] Draining ${pending.length} pending download(s)`);
    let allSucceeded = true;

    for (const path of pending) {
      // Respect explicit local deletes — if the user deleted this path locally
      // (and we recorded it), don't keep trying to bring it back. They can
      // run "Reconcile from server" if they actually want it.
      if (this.fileSync.isLocallyDeleted(path)) {
        console.debug(`[SyncCheck] Removing pending download for locally-deleted path: ${path}`);
        this.fileSync.removePendingDownload(path);
        continue;
      }

      try {
        const result = await this.fileSync.downloadFile(path);
        if (result.success) {
          // Reset failure tracking — clean state for any future stuck cycles.
          this.downloadFailureCounts.delete(path);
          this.notifiedStuckPaths.delete(path);
        } else {
          // 404 → file genuinely gone on server, drop from queue
          if (result.error?.match(/404|not found|Not Found/i)) {
            console.debug(`[SyncCheck] Pending download path ${path} no longer exists on server, dropping`);
            this.fileSync.removePendingDownload(path);
            this.downloadFailureCounts.delete(path);
            this.notifiedStuckPaths.delete(path);
          } else {
            console.warn(`[SyncCheck] Pending download failed for ${path}: ${result.error}`);
            this.recordDownloadFailure(path, result.error || 'unknown error');
            allSucceeded = false;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[SyncCheck] Pending download threw for ${path}:`, err);
        this.recordDownloadFailure(path, msg);
        allSucceeded = false;
      }
    }

    return allSucceeded;
  }

  /**
   * Track per-path download failure counts. After 3 consecutive failures on
   * the same path, surface a Notice once so the user sees the stuck file
   * without having to read logs. The notification is one-shot per path until
   * a successful download resets the counter — we don't want to spam.
   */
  private recordDownloadFailure(path: string, errorMessage: string): void {
    const count = (this.downloadFailureCounts.get(path) || 0) + 1;
    this.downloadFailureCounts.set(path, count);

    if (count >= 3 && !this.notifiedStuckPaths.has(path)) {
      this.notifiedStuckPaths.add(path);
      const shortPath = path.length > 60 ? `…${path.slice(-57)}` : path;
      new Notice(
        `VaultConnect: stuck downloading "${shortPath}". Last error: ${errorMessage.slice(0, 200)}`,
        10000
      );
    }
  }

  /**
   * Reconcile from server: the nuclear option for users whose local sync
   * state has accumulated stale entries (via tombstones, partial deletes,
   * etc.) and is suppressing legitimate downloads. Clears
   * `locallyDeletedFiles`, the pending-downloads queue, and
   * `lastSyncTimestamp`, then runs smartSync. After this, the server is
   * the source of truth: anything present on server lands locally.
   *
   * Local-only files are preserved (they'll be uploaded on next sync as
   * normal), but anything previously deleted locally that still exists on
   * server WILL be restored. Make sure that's what the user wants before
   * invoking this.
   */
  async reconcileFromServer(): Promise<SyncResult> {
    console.debug('[SyncService] Reconcile from server — clearing locally-deleted set and pending-downloads queue');

    this.fileSync.clearLocallyDeleted();
    this.fileSync.clearPendingDownloads();
    await this.fileSync.clearAllSyncState();
    this.lastSyncTimestamp = null;
    await this.storage.set(`lastSyncTimestamp:${this.vaultId}`, null);

    return await this.smartSync();
  }

  /**
   * Perform incremental check - only checks files changed since last sync
   * This is 99% more efficient for typical usage!
   */
  private async performIncrementalCheck(): Promise<void> {
    if (!this.vaultId || !this.lastSyncTimestamp) {
      return;
    }

    // Fetch changed files AND deletions in parallel for efficiency
    const [changedFiles, deletions] = await Promise.all([
      this.apiClient.getChangedFiles(this.vaultId, this.lastSyncTimestamp),
      this.apiClient.getDeletedFiles(this.vaultId, this.lastSyncTimestamp).catch((): Array<{ file_path: string; deleted_at: string; deleted_by: string; is_folder?: boolean }> => [])
    ]);

    // Process server-side deletions immediately
    let deletedCount = 0;
    if (deletions.length > 0) {
      // Separate file and folder deletions
      const fileDeletions = deletions.filter(d => !d.is_folder);
      const folderDeletions = deletions.filter(d => d.is_folder);

      console.debug(`[SyncCheck] 🗑️ ${fileDeletions.length} file + ${folderDeletions.length} folder deletion(s) since last sync`);

      // Process individual file deletions
      for (const deletion of fileDeletions) {
        const localFile = this.vault.getAbstractFileByPath(deletion.file_path);
        if (localFile instanceof TFile) {
          try {
            await this.vault.delete(localFile);
            this.fileSync.addLocallyDeleted(deletion.file_path);
            deletedCount++;
          } catch (err) {
            console.error(`[SyncCheck] Failed to delete local file: ${deletion.file_path}`, err);
          }
        }
      }

      // Process folder deletions — delete all local files under each deleted folder path
      for (const folderDeletion of folderDeletions) {
        const folderPath = folderDeletion.file_path;
        const localFiles = this.vault.getFiles().filter(f => f.path.startsWith(folderPath));
        for (const localFile of localFiles) {
          try {
            await this.vault.delete(localFile);
            this.fileSync.addLocallyDeleted(localFile.path);
            deletedCount++;
          } catch (err) {
            console.error(`[SyncCheck] Failed to delete local file in folder: ${localFile.path}`, err);
          }
        }
        console.debug(`[SyncCheck] Deleted ${localFiles.length} file(s) from folder deletion: ${folderPath}`);
      }

      if (deletedCount > 0) {
        console.debug(`[SyncCheck] 🗑️ Deleted ${deletedCount} local file(s) from server-side deletions`);
      }
    }

    if (changedFiles.length === 0 && deletedCount === 0) {
      console.debug('[SyncCheck] ✓ No remote changes detected');
      return;
    }

    if (changedFiles.length > 0) {
      console.debug(`[SyncCheck] 📥 Found ${changedFiles.length} changed file(s) on remote`, {
        files: changedFiles.map(f => f.path).slice(0, 5),
        ...(changedFiles.length > 5 && { more: `... and ${changedFiles.length - 5} more` })
      });
    }

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

    // Persist drift to the pending-downloads queue immediately. Even if the
    // user has autoSync off or is in PUSH_ALL mode (so smartSync won't run
    // here), the queue + drainPendingDownloads in performSyncCheck will
    // eventually bring these files local — and lastSyncTimestamp won't
    // advance past them until they do.
    for (const path of driftedFiles) {
      this.fileSync.addPendingDownload(path);
    }

    if (driftedFiles.length > 0) {
      console.warn(`[SyncCheck] ⚠️  ${driftedFiles.length} file(s) need sync`, {
        files: driftedFiles.slice(0, 10)
      });

      this.eventBus.emit(EVENTS.SYNC_DRIFT_DETECTED, {
        driftCount: driftedFiles.length,
        files: driftedFiles
      });

      // Auto-trigger sync if the user's mode allows it. The pending-downloads
      // queue is the safety net for the cases this branch doesn't cover.
      if (this.config.mode === SyncMode.SMART_SYNC && this.config.autoSync) {
        console.debug('[SyncCheck] Auto-triggering smart sync...');
        await this.smartSync();
      }
    } else if (deletedCount === 0) {
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

    // Get local files (including binary — getMarkdownFiles() only returns .md)
    const localFiles = this.vault.getFiles();
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
