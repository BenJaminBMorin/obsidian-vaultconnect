import { App, Vault, TFile } from 'obsidian';
import { APIClient } from '../api/APIClient';
import { FileSyncService } from './FileSyncService';
import { StorageManager } from '../core/StorageManager';
import { EventBus } from '../core/EventBus';
import { logger } from '../utils/logger';
import {
  InitialSyncState,
  InitialSyncOption,
  FileAnalysis,
  ProgressInfo,
  InitialSyncError,
  InitialSyncErrorInfo
} from '../types/initial-sync.types';

/**
 * Settings interface for InitialSyncService
 */
interface InitialSyncSettings {
  excludedFolders: string[];
}

/**
 * Service for handling initial sync setup when connecting to a vault for the first time.
 *
 * This service detects first-time connections, analyzes file differences between local
 * and remote vaults, and executes the user's chosen sync strategy.
 */
export class InitialSyncService {
  private app: App;
  private vault: Vault;
  private apiClient: APIClient;
  private fileSync: FileSyncService;
  private storage: StorageManager;
  private eventBus: EventBus;
  private settings: InitialSyncSettings;

  // State management
  private currentVaultId: string | null = null;
  private isAnalyzing: boolean = false;
  private isSyncing: boolean = false;
  private cancelRequested: boolean = false;

  constructor(
    app: App,
    apiClient: APIClient,
    fileSync: FileSyncService,
    storage: StorageManager,
    eventBus: EventBus,
    settings: InitialSyncSettings
  ) {
    this.app = app;
    this.vault = app.vault;
    this.apiClient = apiClient;
    this.fileSync = fileSync;
    this.storage = storage;
    this.eventBus = eventBus;
    this.settings = settings;

    logger.debug('[InitialSync] Service initialized with settings:', {
      excludedFolders: settings.excludedFolders
    });
  }

  /**
   * Check if this is the first time connecting to a vault
   * 
   * @param vaultId - The VaultSync vault ID
   * @returns true if no sync state exists for this vault
   */
  async isFirstTimeConnection(vaultId: string): Promise<boolean> {
    logger.debug('[InitialSync] Checking first-time connection for vault:', vaultId);

    try {
      const syncState = await this.getSyncState(vaultId);
      const isFirstTime = !syncState || !syncState.completed;

      logger.debug('[InitialSync] First-time detection result:', {
        vaultId,
        isFirstTime,
        existingState: syncState ? {
          completed: syncState.completed,
          completedAt: syncState.completedAt,
          chosenOption: syncState.chosenOption
        } : null
      });
      
      return isFirstTime;
    } catch (error) {
      logger.error('[InitialSync] Error checking first-time connection:', {
        vaultId,
        error: error.message,
        stack: error.stack
      });
      
      // Emit error event
      this.eventBus.emit('initial-sync:error', {
        type: InitialSyncError.FILE_OPERATION_ERROR,
        message: 'Failed to check sync state. Assuming first-time connection.',
        details: error,
        recoverable: true
      } as InitialSyncErrorInfo);
      
      // If we can't determine, assume it's first time to be safe
      logger.debug('[InitialSync] Defaulting to first-time connection due to error');
      return true;
    }
  }

  /**
   * Get the sync state for a vault
   * 
   * @param vaultId - The VaultSync vault ID
   * @returns The sync state or null if not found
   */
  async getSyncState(vaultId: string): Promise<InitialSyncState | null> {
    logger.debug('[InitialSync] Retrieving sync state for vault:', vaultId);
    
    try {
      const states = await this.storage.get<Record<string, InitialSyncState>>('initialSyncStates');
      
      if (!states || !states[vaultId]) {
        logger.debug('[InitialSync] No sync state found for vault:', vaultId);
        return null;
      }

      const state = states[vaultId];
      
      // Convert date string back to Date object if needed
      if (state.completedAt && typeof state.completedAt === 'string') {
        state.completedAt = new Date(state.completedAt);
      }

      logger.debug('[InitialSync] Retrieved sync state:', {
        vaultId,
        completed: state.completed,
        completedAt: state.completedAt,
        chosenOption: state.chosenOption,
        fileCounts: state.fileCounts
      });

      return state;
    } catch (error) {
      logger.error('[InitialSync] Error getting sync state:', {
        vaultId,
        error: error.message,
        stack: error.stack
      });
      
      // Emit error event
      this.eventBus.emit('initial-sync:error', {
        type: InitialSyncError.FILE_OPERATION_ERROR,
        message: 'Failed to retrieve sync state from storage.',
        details: error,
        recoverable: true
      } as InitialSyncErrorInfo);
      
      return null;
    }
  }

  /**
   * Mark initial sync as complete for a vault
   * 
   * @param vaultId - The VaultSync vault ID
   * @param option - The sync option that was chosen
   * @param fileCounts - File counts from the analysis
   */
  async markSyncComplete(
    vaultId: string,
    option: InitialSyncOption,
    fileCounts: FileAnalysis
  ): Promise<void> {
    logger.debug('[InitialSync] Marking sync complete:', {
      vaultId,
      option,
      fileCounts: {
        localOnly: fileCounts.localFiles.length,
        remoteOnly: fileCounts.remoteFiles.length,
        both: fileCounts.commonFiles.length,
        excluded: fileCounts.excludedFiles.length
      }
    });

    try {
      // Get existing states
      const states = await this.storage.get<Record<string, InitialSyncState>>('initialSyncStates') || {};

      // Create new state
      const newState: InitialSyncState = {
        vaultId,
        completed: true,
        completedAt: new Date(),
        chosenOption: option,
        fileCounts: {
          localOnly: fileCounts.localFiles.length,
          remoteOnly: fileCounts.remoteFiles.length,
          both: fileCounts.commonFiles.length,
          excluded: fileCounts.excludedFiles.length
        }
      };

      // Update states
      states[vaultId] = newState;

      // Save to storage
      await this.storage.set('initialSyncStates', states);

      logger.debug('[InitialSync] Sync state saved successfully:', {
        vaultId,
        completedAt: newState.completedAt,
        option: newState.chosenOption,
        fileCounts: newState.fileCounts
      });
    } catch (error) {
      logger.error('[InitialSync] Error marking sync complete:', {
        vaultId,
        option,
        error: error.message,
        stack: error.stack
      });
      
      // Emit error event
      this.eventBus.emit('initial-sync:error', {
        type: InitialSyncError.FILE_OPERATION_ERROR,
        message: 'Failed to save sync completion state. Your sync completed but may need to be redone on next connection.',
        details: error,
        recoverable: false
      } as InitialSyncErrorInfo);
      
      throw error;
    }
  }

  /**
   * Reset sync state for a vault (for troubleshooting)
   * 
   * @param vaultId - The VaultSync vault ID
   */
  async resetSyncState(vaultId: string): Promise<void> {
    logger.debug('[InitialSync] Resetting sync state for vault:', vaultId);

    try {
      const states = await this.storage.get<Record<string, InitialSyncState>>('initialSyncStates') || {};
      
      // Log existing state before reset
      if (states[vaultId]) {
        logger.debug('[InitialSync] Existing state before reset:', {
          vaultId,
          completed: states[vaultId].completed,
          completedAt: states[vaultId].completedAt,
          chosenOption: states[vaultId].chosenOption,
          fileCounts: states[vaultId].fileCounts
        });
      } else {
        logger.debug('[InitialSync] No existing state found for vault:', vaultId);
      }
      
      // Remove the state for this vault
      delete states[vaultId];
      
      // Save updated states
      await this.storage.set('initialSyncStates', states);

      logger.debug('[InitialSync] Sync state reset successfully for vault:', vaultId);
    } catch (error) {
      logger.error('[InitialSync] Error resetting sync state:', {
        vaultId,
        error: error.message,
        stack: error.stack
      });
      
      // Emit error event
      this.eventBus.emit('initial-sync:error', {
        type: InitialSyncError.FILE_OPERATION_ERROR,
        message: 'Failed to reset sync state. Please try again.',
        details: error,
        recoverable: true
      } as InitialSyncErrorInfo);
      
      throw error;
    }
  }

  /**
   * Scan local vault for all files
   * 
   * @returns Array of file paths relative to vault root
   * @private
   */
  private async scanLocalFiles(): Promise<string[]> {
    logger.debug('[InitialSync] Scanning local files...');

    try {
      const files = this.vault.getFiles(); // Changed from getMarkdownFiles() to getFiles()
      const filePaths: string[] = [];
      const excludedPaths: string[] = [];

      for (const file of files) {
        const path = file.path;

        // Check if file is in an excluded folder
        const isExcluded = this.settings.excludedFolders.some(excludedFolder => {
          // Normalize folder path (remove leading/trailing slashes)
          const normalizedExcluded = excludedFolder.replace(/^\/+|\/+$/g, '');
          // Check if file path starts with excluded folder
          return path.startsWith(normalizedExcluded + '/') || path === normalizedExcluded;
        });

        if (!isExcluded) {
          filePaths.push(path);
        } else {
          excludedPaths.push(path);
        }
      }

      logger.debug('[InitialSync] Local file scan complete:', {
        totalFiles: files.length,
        includedFiles: filePaths.length,
        excludedFiles: excludedPaths.length,
        excludedFolders: this.settings.excludedFolders
      });
      
      // Log sample paths for debugging
      if (filePaths.length > 0) {
        logger.debug('[InitialSync] Sample included files:', filePaths.slice(0, 5));
      }
      if (excludedPaths.length > 0) {
        logger.debug('[InitialSync] Sample excluded files:', excludedPaths.slice(0, 5));
      }
      
      return filePaths;
    } catch (error) {
      logger.error('[InitialSync] Error scanning local files:', {
        error: error.message,
        stack: error.stack
      });
      
      // Emit error event
      this.eventBus.emit('initial-sync:error', {
        type: InitialSyncError.PERMISSION_ERROR,
        message: 'Failed to scan local vault files. Please check file permissions.',
        details: error,
        recoverable: false
      } as InitialSyncErrorInfo);
      
      throw new Error(`Failed to scan local files: ${error.message}`);
    }
  }

  /**
   * Fetch remote files from VaultSync with retry logic
   * 
   * @param vaultId - The VaultSync vault ID
   * @returns Array of file paths
   * @private
   */
  private async fetchRemoteFiles(vaultId: string): Promise<string[]> {
    logger.debug('[InitialSync] Fetching remote files for vault:', vaultId);

    try {
      const filePaths = await this.retryWithBackoff(
        async () => {
          const files = await this.apiClient.listFiles(vaultId);
          return files.map(file => file.path);
        },
        'fetch-remote-files',
        3
      );

      logger.debug('[InitialSync] Remote file fetch complete:', {
        vaultId,
        fileCount: filePaths.length
      });
      
      // Log sample paths for debugging
      if (filePaths.length > 0) {
        logger.debug('[InitialSync] Sample remote files:', filePaths.slice(0, 5));
      }
      
      return filePaths;
    } catch (error) {
      logger.error('[InitialSync] Error fetching remote files:', {
        vaultId,
        error: error.message,
        stack: error.stack
      });
      
      // Emit final error event
      this.eventBus.emit('initial-sync:error', {
        type: error.message.includes('cancelled') 
          ? InitialSyncError.USER_CANCELLED
          : InitialSyncError.NETWORK_ERROR,
        message: error.message.includes('cancelled')
          ? 'Operation cancelled by user.'
          : 'Failed to fetch remote files after 3 attempts. Please check your internet connection.',
        details: error,
        recoverable: !error.message.includes('cancelled')
      } as InitialSyncErrorInfo);
      
      throw error;
    }
  }

  /**
   * Analyze file differences between local and remote vaults
   * 
   * @param vaultId - The VaultSync vault ID
   * @returns FileAnalysis object with categorized files and counts
   */
  async analyzeFiles(vaultId: string): Promise<FileAnalysis> {
    logger.debug('[InitialSync] Starting file analysis for vault:', vaultId);

    // Set analyzing state
    this.isAnalyzing = true;
    this.currentVaultId = vaultId;
    this.cancelRequested = false;

    try {
      // Emit analyzing event
      this.eventBus.emit('initial-sync:progress', {
        operation: 'analyzing',
        currentFile: '',
        completed: 0,
        total: 0,
        percentage: 0
      } as ProgressInfo);

      // Create timeout promise (30 seconds)
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('File analysis timed out after 30 seconds'));
        }, 30000);
      });

      // Fetch local and remote files in parallel
      logger.debug('[InitialSync] Fetching local and remote files in parallel...');
      const analysisPromise = Promise.all([
        this.scanLocalFiles(),
        this.fetchRemoteFiles(vaultId)
      ]);

      // Race between analysis and timeout
      const [localPaths, remotePaths] = await Promise.race([
        analysisPromise,
        timeoutPromise
      ]);

      // Check if cancelled
      if (this.cancelRequested) {
        logger.debug('[InitialSync] File analysis cancelled by user');
        throw new Error('File analysis cancelled by user');
      }

      logger.debug('[InitialSync] Comparing file lists...');
      
      // Convert to sets for efficient comparison
      const localSet = new Set(localPaths);
      const remoteSet = new Set(remotePaths);

      // Categorize files
      const localFiles: string[] = [];
      const remoteFiles: string[] = [];
      const commonFiles: string[] = [];

      // Find files only in local
      for (const path of localPaths) {
        if (!remoteSet.has(path)) {
          localFiles.push(path);
        } else {
          commonFiles.push(path);
        }
      }

      // Find files only in remote
      for (const path of remotePaths) {
        if (!localSet.has(path)) {
          remoteFiles.push(path);
        }
      }

      // Get excluded files count
      const allLocalFiles = this.vault.getFiles(); // Changed from getMarkdownFiles() to getFiles()
      const excludedFiles: string[] = [];
      
      for (const file of allLocalFiles) {
        const path = file.path;
        const isExcluded = this.settings.excludedFolders.some(excludedFolder => {
          const normalizedExcluded = excludedFolder.replace(/^\/+|\/+$/g, '');
          return path.startsWith(normalizedExcluded + '/') || path === normalizedExcluded;
        });

        if (isExcluded) {
          excludedFiles.push(path);
        }
      }

      const analysis: FileAnalysis = {
        localFiles,
        remoteFiles,
        commonFiles,
        excludedFiles,
        totalLocal: localPaths.length,
        totalRemote: remotePaths.length
      };

      logger.debug('[InitialSync] File analysis complete:', {
        vaultId,
        localOnly: localFiles.length,
        remoteOnly: remoteFiles.length,
        both: commonFiles.length,
        excluded: excludedFiles.length,
        totalLocal: analysis.totalLocal,
        totalRemote: analysis.totalRemote
      });

      // Log sample paths for debugging
      if (localFiles.length > 0) {
        logger.debug('[InitialSync] Sample local-only files:', localFiles.slice(0, 5));
      }
      if (remoteFiles.length > 0) {
        logger.debug('[InitialSync] Sample remote-only files:', remoteFiles.slice(0, 5));
      }
      if (commonFiles.length > 0) {
        logger.debug('[InitialSync] Sample common files:', commonFiles.slice(0, 5));
      }
      if (excludedFiles.length > 0) {
        logger.debug('[InitialSync] Sample excluded files:', excludedFiles.slice(0, 5));
      }

      return analysis;
    } catch (error) {
      logger.error('[InitialSync] Error during file analysis:', {
        vaultId,
        error: error.message,
        stack: error.stack
      });
      
      // Determine error type and create user-friendly message
      let errorType = InitialSyncError.FILE_OPERATION_ERROR;
      let userMessage = 'Failed to analyze files. Please try again.';
      
      if (error.message.includes('timed out')) {
        errorType = InitialSyncError.ANALYSIS_TIMEOUT;
        userMessage = 'File analysis took too long. This may be due to a large vault or slow connection. Please try again.';
      } else if (error.message.includes('cancelled')) {
        errorType = InitialSyncError.USER_CANCELLED;
        userMessage = 'File analysis was cancelled.';
      } else if (error.message.includes('network') || error.message.includes('fetch')) {
        errorType = InitialSyncError.NETWORK_ERROR;
        userMessage = 'Network error during file analysis. Please check your connection and try again.';
      } else if (error.message.includes('permission')) {
        errorType = InitialSyncError.PERMISSION_ERROR;
        userMessage = 'Permission error accessing files. Please check file permissions.';
      }
      
      // Emit error event
      this.eventBus.emit('initial-sync:error', {
        type: errorType,
        message: userMessage,
        details: error,
        recoverable: errorType !== InitialSyncError.PERMISSION_ERROR
      } as InitialSyncErrorInfo);

      throw error;
    } finally {
      this.isAnalyzing = false;
      this.currentVaultId = null;
    }
  }

  /**
   * Execute Start Fresh operation
   * Deletes all local files and downloads everything from remote
   * 
   * @param vaultId - The VaultSync vault ID
   * @param analysis - File analysis result
   * @returns Summary of operations performed
   */
  async executeStartFresh(vaultId: string, analysis: FileAnalysis): Promise<{
    deleted: number;
    downloaded: number;
    errors: string[];
  }> {
    logger.debug('[InitialSync] Starting Start Fresh operation:', {
      vaultId,
      filesToDelete: analysis.localFiles.length + analysis.commonFiles.length,
      filesToDownload: analysis.remoteFiles.length + analysis.commonFiles.length
    });

    this.isSyncing = true;
    this.currentVaultId = vaultId;
    this.cancelRequested = false;

    const errors: string[] = [];
    let deleted = 0;
    let downloaded = 0;

    try {
      // Calculate total operations
      const filesToDelete = [...analysis.localFiles, ...analysis.commonFiles];
      const filesToDownload = [...analysis.remoteFiles, ...analysis.commonFiles];
      const totalOperations = filesToDelete.length + filesToDownload.length;
      let completed = 0;

      // Phase 1: Delete all local files (except excluded)
      logger.debug('[InitialSync] Phase 1: Deleting', filesToDelete.length, 'local files...');

      for (const filePath of filesToDelete) {
        if (this.cancelRequested) {
          logger.debug('[InitialSync] Start Fresh cancelled by user during deletion phase');
          throw new Error('Operation cancelled by user');
        }

        try {
          // Emit progress
          this.eventBus.emit('initial-sync:progress', {
            operation: 'deleting',
            currentFile: filePath,
            completed,
            total: totalOperations,
            percentage: Math.round((completed / totalOperations) * 100)
          } as ProgressInfo);

          // Get file
          const file = this.vault.getAbstractFileByPath(filePath);
          
          if (file && file instanceof TFile) {
            await this.app.fileManager.trashFile(file);
            deleted++;
            logger.debug('[InitialSync] Deleted:', filePath);
          }

          completed++;
        } catch (error) {
          const errorMsg = `Failed to delete ${filePath}: ${error.message}`;
          logger.error('[InitialSync]', errorMsg);
          errors.push(errorMsg);
          completed++;
          // Continue with other files
        }
      }

      logger.debug('[InitialSync] Phase 1 complete:', {
        deleted,
        errors: errors.length
      });

      // Phase 2: Download all remote files (in parallel batches)
      logger.debug('[InitialSync] Phase 2: Downloading', filesToDownload.length, 'remote files...');

      const BATCH_SIZE = 5; // Process 5 files at a time
      const downloadBatches = this.createBatches(filesToDownload, BATCH_SIZE);

      for (const batch of downloadBatches) {
        if (this.cancelRequested) {
          logger.debug('[InitialSync] Start Fresh cancelled by user during download phase');
          throw new Error('Operation cancelled by user');
        }

        // Process batch in parallel
        const batchPromises = batch.map(async (filePath) => {
          try {
            // Emit progress
            this.eventBus.emit('initial-sync:progress', {
              operation: 'downloading',
              currentFile: filePath,
              completed,
              total: totalOperations,
              percentage: Math.round((completed / totalOperations) * 100)
            } as ProgressInfo);

            // Download file using FileSyncService with retry
            const result = await this.retryWithBackoff(
              async () => {
                const downloadResult = await this.fileSync.downloadFile(filePath);
                if (!downloadResult.success) {
                  throw new Error(downloadResult.error || 'Download failed');
                }
                return downloadResult;
              },
              `download-${filePath}`,
              3
            );

            logger.debug('[InitialSync] Downloaded:', filePath);
            return { success: true, filePath };
          } catch (error) {
            const errorMsg = `Failed to download ${filePath}: ${error.message}`;
            logger.error('[InitialSync]', errorMsg);
            return { success: false, filePath, error: errorMsg };
          }
        });

        // Wait for all files in batch to complete
        const results = await Promise.all(batchPromises);

        // Process results
        for (const result of results) {
          if (result.success) {
            downloaded++;
          } else if (result.error) {
            errors.push(result.error);
          }
          completed++;
        }
      }

      const summary = { deleted, downloaded, errors };
      logger.debug('[InitialSync] Start Fresh complete:', {
        vaultId,
        deleted,
        downloaded,
        errorCount: errors.length,
        totalOperations
      });

      return summary;
    } catch (error) {
      logger.error('[InitialSync] Start Fresh operation failed:', {
        vaultId,
        deleted,
        downloaded,
        errorCount: errors.length,
        error: error.message,
        stack: error.stack
      });
      
      // Determine error type and create user-friendly message
      let errorType = InitialSyncError.FILE_OPERATION_ERROR;
      let userMessage = 'Start Fresh operation failed. Some files may have been deleted or downloaded.';
      
      if (error.message.includes('cancelled')) {
        errorType = InitialSyncError.USER_CANCELLED;
        userMessage = 'Start Fresh operation was cancelled. Your vault may be in a partial state.';
      } else if (error.message.includes('network') || error.message.includes('fetch')) {
        errorType = InitialSyncError.NETWORK_ERROR;
        userMessage = 'Network error during Start Fresh. Please check your connection and try again.';
      } else if (error.message.includes('permission')) {
        errorType = InitialSyncError.PERMISSION_ERROR;
        userMessage = 'Permission error during Start Fresh. Please check file permissions.';
      } else if (error.message.includes('quota') || error.message.includes('space')) {
        errorType = InitialSyncError.STORAGE_QUOTA_ERROR;
        userMessage = 'Storage quota exceeded. Please free up space and try again.';
      }
      
      // Emit error event
      this.eventBus.emit('initial-sync:error', {
        type: errorType,
        message: userMessage,
        details: { error, deleted, downloaded, errors },
        recoverable: errorType !== InitialSyncError.PERMISSION_ERROR && errorType !== InitialSyncError.USER_CANCELLED
      } as InitialSyncErrorInfo);

      throw error;
    } finally {
      this.isSyncing = false;
      this.currentVaultId = null;
    }
  }

  /**
   * Execute Upload Local operation
   * Uploads all local files to remote, overwriting conflicts
   *
   * @param vaultId - The VaultSync vault ID
   * @param analysis - File analysis result
   * @returns Summary of operations performed
   */
  async executeUploadLocal(vaultId: string, analysis: FileAnalysis): Promise<{
    uploaded: number;
    errors: string[];
  }> {
    logger.debug('[InitialSync] Starting Upload Local operation:', {
      vaultId,
      filesToUpload: analysis.localFiles.length + analysis.commonFiles.length
    });

    this.isSyncing = true;
    this.currentVaultId = vaultId;
    this.cancelRequested = false;

    const errors: string[] = [];
    let uploaded = 0;

    try {
      // Calculate total operations
      const filesToUpload = [...analysis.localFiles, ...analysis.commonFiles];
      const totalOperations = filesToUpload.length;
      let completed = 0;

      logger.debug('[InitialSync] Uploading', filesToUpload.length, 'local files...');

      const BATCH_SIZE = 5; // Process 5 files at a time
      const uploadBatches = this.createBatches(filesToUpload, BATCH_SIZE);

      for (const batch of uploadBatches) {
        if (this.cancelRequested) {
          logger.debug('[InitialSync] Upload Local cancelled by user');
          throw new Error('Operation cancelled by user');
        }

        // Process batch in parallel
        const batchPromises = batch.map(async (filePath) => {
          try {
            // Emit progress
            this.eventBus.emit('initial-sync:progress', {
              operation: 'uploading',
              currentFile: filePath,
              completed,
              total: totalOperations,
              percentage: Math.round((completed / totalOperations) * 100)
            } as ProgressInfo);

            // Get file
            const file = this.vault.getAbstractFileByPath(filePath);

            if (file instanceof TFile) {
              // Upload file using FileSyncService with retry
              // For "Upload Local", we can use forceCreate for local-only files
              // For common files, we need to update, so use regular upload
              // Use skipSaveState=true to avoid disk I/O contention during batch upload
              const isLocalOnly = analysis.localFiles.includes(filePath);
              const result = await this.retryWithBackoff(
                async () => {
                  const uploadResult = await this.fileSync.uploadFile(file, isLocalOnly, true);
                  if (!uploadResult.success) {
                    throw new Error(uploadResult.error || 'Upload failed');
                  }
                  return uploadResult;
                },
                `upload-${filePath}`,
                3
              );

              logger.debug('[InitialSync] Uploaded:', filePath);
              return { success: true, filePath };
            } else {
              const errorMsg = `File not found: ${filePath}`;
              logger.error('[InitialSync]', errorMsg);
              return { success: false, filePath, error: errorMsg };
            }
          } catch (error) {
            const errorMsg = `Failed to upload ${filePath}: ${error.message}`;
            logger.error('[InitialSync]', errorMsg);
            return { success: false, filePath, error: errorMsg };
          }
        });

        // Wait for all files in batch to complete
        const results = await Promise.all(batchPromises);

        // Process results
        for (const result of results) {
          if (result.success) {
            uploaded++;
          } else if (result.error) {
            errors.push(result.error);
          }
          completed++;
        }
      }

      // Save sync state once after all uploads (instead of after each file)
      logger.debug('[InitialSync] Saving sync state...');
      await this.fileSync.saveSyncState();
      logger.debug('[InitialSync] Sync state saved');

      const summary = { uploaded, errors };
      logger.debug('[InitialSync] Upload Local complete:', {
        vaultId,
        uploaded,
        errorCount: errors.length,
        totalOperations
      });

      return summary;
    } catch (error) {
      logger.error('[InitialSync] Upload Local operation failed:', {
        vaultId,
        uploaded,
        errorCount: errors.length,
        error: error.message,
        stack: error.stack
      });
      
      // Determine error type and create user-friendly message
      let errorType = InitialSyncError.FILE_OPERATION_ERROR;
      let userMessage = 'Upload Local operation failed. Some files may have been uploaded.';
      
      if (error.message.includes('cancelled')) {
        errorType = InitialSyncError.USER_CANCELLED;
        userMessage = 'Upload Local operation was cancelled. Some files may have been uploaded.';
      } else if (error.message.includes('network') || error.message.includes('fetch')) {
        errorType = InitialSyncError.NETWORK_ERROR;
        userMessage = 'Network error during Upload Local. Please check your connection and try again.';
      } else if (error.message.includes('permission')) {
        errorType = InitialSyncError.PERMISSION_ERROR;
        userMessage = 'Permission error during Upload Local. Please check file permissions.';
      } else if (error.message.includes('quota') || error.message.includes('space')) {
        errorType = InitialSyncError.STORAGE_QUOTA_ERROR;
        userMessage = 'Storage quota exceeded on server. Please free up space and try again.';
      }
      
      // Emit error event
      this.eventBus.emit('initial-sync:error', {
        type: errorType,
        message: userMessage,
        details: { error, uploaded, errors },
        recoverable: errorType !== InitialSyncError.PERMISSION_ERROR && errorType !== InitialSyncError.USER_CANCELLED
      } as InitialSyncErrorInfo);

      throw error;
    } finally {
      this.isSyncing = false;
      this.currentVaultId = null;
    }
  }

  /**
   * Execute Smart Merge operation
   * Intelligently merges files from both locations
   *
   * @param vaultId - The VaultSync vault ID
   * @param analysis - File analysis result
   * @returns Summary of operations performed including conflicts
   */
  async executeSmartMerge(vaultId: string, analysis: FileAnalysis): Promise<{
    uploaded: number;
    downloaded: number;
    conflicts: string[];
    errors: string[];
  }> {
    logger.debug('[InitialSync] Starting Smart Merge operation:', {
      vaultId,
      localOnlyFiles: analysis.localFiles.length,
      remoteOnlyFiles: analysis.remoteFiles.length,
      commonFiles: analysis.commonFiles.length
    });

    this.isSyncing = true;
    this.currentVaultId = vaultId;
    this.cancelRequested = false;

    const errors: string[] = [];
    const conflicts: string[] = [];
    let uploaded = 0;
    let downloaded = 0;

    try {
      // Calculate total operations
      const totalOperations = analysis.localFiles.length +
                             analysis.remoteFiles.length +
                             analysis.commonFiles.length;
      let completed = 0;

      // Phase 1: Upload files that only exist locally (in parallel batches)
      logger.debug('[InitialSync] Phase 1: Uploading', analysis.localFiles.length, 'local-only files...');

      const BATCH_SIZE = 5; // Process 5 files at a time
      const uploadBatches = this.createBatches(analysis.localFiles, BATCH_SIZE);

      for (const batch of uploadBatches) {
        if (this.cancelRequested) {
          logger.debug('[InitialSync] Smart Merge cancelled by user during upload phase');
          throw new Error('Operation cancelled by user');
        }

        // Process batch in parallel
        const batchPromises = batch.map(async (filePath) => {
          try {
            // Emit progress
            this.eventBus.emit('initial-sync:progress', {
              operation: 'merging',
              currentFile: filePath,
              completed,
              total: totalOperations,
              percentage: Math.round((completed / totalOperations) * 100)
            } as ProgressInfo);

            // Get file
            const file = this.vault.getAbstractFileByPath(filePath);

            if (file instanceof TFile) {
              // Upload file using FileSyncService with retry
              // Use forceCreate=true since we know these are local-only files (don't exist remotely)
              // Use skipSaveState=true to avoid disk I/O contention during batch upload
              const result = await this.retryWithBackoff(
                async () => {
                  const uploadResult = await this.fileSync.uploadFile(file, true, true);
                  if (!uploadResult.success) {
                    throw new Error(uploadResult.error || 'Upload failed');
                  }
                  return uploadResult;
                },
                `upload-${filePath}`,
                3
              );

              logger.debug('[InitialSync] Uploaded local-only file:', filePath);
              return { success: true, filePath };
            }
            return { success: false, filePath, error: 'File not found' };
          } catch (error) {
            const errorMsg = `Failed to upload ${filePath}: ${error.message}`;
            logger.error('[InitialSync]', errorMsg);
            return { success: false, filePath, error: errorMsg };
          }
        });

        // Wait for all files in batch to complete
        const results = await Promise.all(batchPromises);

        // Process results
        for (const result of results) {
          if (result.success) {
            uploaded++;
          } else if (result.error) {
            errors.push(result.error);
          }
          completed++;
        }
      }

      logger.debug('[InitialSync] Phase 1 complete:', {
        uploaded,
        errors: errors.length
      });

      // Save sync state once after all uploads (instead of after each file)
      logger.debug('[InitialSync] Saving sync state after Phase 1...');
      await this.fileSync.saveSyncState();
      logger.debug('[InitialSync] Sync state saved');

      // Phase 2: Download files that only exist remotely (in parallel batches)
      logger.debug('[InitialSync] Phase 2: Downloading', analysis.remoteFiles.length, 'remote-only files...');

      const downloadBatches = this.createBatches(analysis.remoteFiles, BATCH_SIZE);

      for (const batch of downloadBatches) {
        if (this.cancelRequested) {
          logger.debug('[InitialSync] Smart Merge cancelled by user during download phase');
          throw new Error('Operation cancelled by user');
        }

        // Process batch in parallel
        const batchPromises = batch.map(async (filePath) => {
          try {
            // Emit progress
            this.eventBus.emit('initial-sync:progress', {
              operation: 'merging',
              currentFile: filePath,
              completed,
              total: totalOperations,
              percentage: Math.round((completed / totalOperations) * 100)
            } as ProgressInfo);

            // Download file using FileSyncService with retry
            const result = await this.retryWithBackoff(
              async () => {
                const downloadResult = await this.fileSync.downloadFile(filePath);
                if (!downloadResult.success) {
                  throw new Error(downloadResult.error || 'Download failed');
                }
                return downloadResult;
              },
              `download-${filePath}`,
              3
            );

            logger.debug('[InitialSync] Downloaded remote-only file:', filePath);
            return { success: true, filePath };
          } catch (error) {
            const errorMsg = `Failed to download ${filePath}: ${error.message}`;
            logger.error('[InitialSync]', errorMsg);
            return { success: false, filePath, error: errorMsg };
          }
        });

        // Wait for all files in batch to complete
        const results = await Promise.all(batchPromises);

        // Process results
        for (const result of results) {
          if (result.success) {
            downloaded++;
          } else if (result.error) {
            errors.push(result.error);
          }
          completed++;
        }
      }

      logger.debug('[InitialSync] Phase 2 complete:', {
        downloaded,
        errors: errors.length
      });

      // Phase 3: Handle files that exist in both locations
      logger.debug('[InitialSync] Phase 3: Processing', analysis.commonFiles.length, 'common files...');

      for (const filePath of analysis.commonFiles) {
        if (this.cancelRequested) {
          logger.debug('[InitialSync] Smart Merge cancelled by user during conflict resolution phase');
          throw new Error('Operation cancelled by user');
        }

        try {
          // Emit progress
          this.eventBus.emit('initial-sync:progress', {
            operation: 'merging',
            currentFile: filePath,
            completed,
            total: totalOperations,
            percentage: Math.round((completed / totalOperations) * 100)
          } as ProgressInfo);

          // Get local file
          const localFile = this.vault.getAbstractFileByPath(filePath);
          
          if (!(localFile instanceof TFile)) {
            logger.debug('[InitialSync] Skipping non-file:', filePath);
            completed++;
            continue;
          }

          // Read local content
          const localContent = await this.vault.read(localFile);
          const localHash = await this.computeHash(localContent);

          // Get remote file info
          const remoteFile = await this.apiClient.getFileByPath(vaultId, filePath);
          const remoteHash = remoteFile.hash;

          logger.debug('[InitialSync] Comparing hashes for:', {
            filePath,
            localHash: localHash.substring(0, 8) + '...',
            remoteHash: remoteHash.substring(0, 8) + '...',
            match: localHash === remoteHash
          });

          // Compare hashes
          if (localHash !== remoteHash) {
            // Content differs - create conflict copy
            logger.debug('[InitialSync] Conflict detected for:', {
              filePath,
              localSize: localContent.length
            });

            // Generate conflict copy name with timestamp
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
            const pathParts = filePath.split('/');
            const fileName = pathParts.pop() || '';
            const fileNameParts = fileName.split('.');
            const extension = fileNameParts.length > 1 ? fileNameParts.pop() : '';
            const baseName = fileNameParts.join('.');
            const conflictName = extension 
              ? `${baseName} (conflict ${timestamp}).${extension}`
              : `${baseName} (conflict ${timestamp})`;
            const conflictPath = pathParts.length > 0 
              ? `${pathParts.join('/')}/${conflictName}`
              : conflictName;

            // Rename local file to conflict copy
            await this.vault.rename(localFile, conflictPath);
            conflicts.push(filePath);
            logger.debug('[InitialSync] Created conflict copy:', {
              originalPath: filePath,
              conflictPath
            });

            // Download remote version as main file with retry
            const result = await this.retryWithBackoff(
              async () => {
                const downloadResult = await this.fileSync.downloadFile(filePath);
                if (!downloadResult.success) {
                  throw new Error(downloadResult.error || 'Download failed');
                }
                return downloadResult;
              },
              `download-${filePath}`,
              3
            );
            
            downloaded++;
            logger.debug('[InitialSync] Downloaded remote version:', filePath);
          } else {
            // Content is the same - no action needed
            logger.debug('[InitialSync] Files match, no action needed:', filePath);
          }

          completed++;
        } catch (error) {
          const errorMsg = `Failed to process ${filePath}: ${error.message}`;
          logger.error('[InitialSync]', errorMsg);
          errors.push(errorMsg);
          completed++;
        }
      }

      logger.debug('[InitialSync] Phase 3 complete:', {
        conflicts: conflicts.length,
        errors: errors.length
      });

      const summary = { uploaded, downloaded, conflicts, errors };
      logger.debug('[InitialSync] Smart Merge complete:', {
        vaultId,
        uploaded,
        downloaded,
        conflicts: conflicts.length,
        errorCount: errors.length,
        totalOperations
      });

      // Log conflict details if any
      if (conflicts.length > 0) {
        logger.debug('[InitialSync] Conflicts created for files:', conflicts);
      }

      return summary;
    } catch (error) {
      logger.error('[InitialSync] Smart Merge operation failed:', {
        vaultId,
        uploaded,
        downloaded,
        conflicts: conflicts.length,
        errorCount: errors.length,
        error: error.message,
        stack: error.stack
      });
      
      // Determine error type and create user-friendly message
      let errorType = InitialSyncError.FILE_OPERATION_ERROR;
      let userMessage = 'Smart Merge operation failed. Some files may have been synced.';
      
      if (error.message.includes('cancelled')) {
        errorType = InitialSyncError.USER_CANCELLED;
        userMessage = 'Smart Merge operation was cancelled. Your vault may be in a partial state.';
      } else if (error.message.includes('network') || error.message.includes('fetch')) {
        errorType = InitialSyncError.NETWORK_ERROR;
        userMessage = 'Network error during Smart Merge. Please check your connection and try again.';
      } else if (error.message.includes('permission')) {
        errorType = InitialSyncError.PERMISSION_ERROR;
        userMessage = 'Permission error during Smart Merge. Please check file permissions.';
      } else if (error.message.includes('quota') || error.message.includes('space')) {
        errorType = InitialSyncError.STORAGE_QUOTA_ERROR;
        userMessage = 'Storage quota exceeded. Please free up space and try again.';
      }
      
      // Emit error event
      this.eventBus.emit('initial-sync:error', {
        type: errorType,
        message: userMessage,
        details: { error, uploaded, downloaded, conflicts, errors },
        recoverable: errorType !== InitialSyncError.PERMISSION_ERROR && errorType !== InitialSyncError.USER_CANCELLED
      } as InitialSyncErrorInfo);

      throw error;
    } finally {
      this.isSyncing = false;
      this.currentVaultId = null;
    }
  }

  /**
   * Retry a function with exponential backoff
   * 
   * @param fn - Function to retry
   * @param operationName - Name of the operation for logging
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   * @returns Result of the function
   * @private
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    operationName: string,
    maxRetries: number = 3
  ): Promise<T> {
    let retryCount = 0;
    const retryDelay = 1000; // Start with 1 second

    console.log(`[InitialSync] Starting operation with retry: ${operationName} (max retries: ${maxRetries})`);

    while (retryCount < maxRetries) {
      try {
        const result = await fn();
        if (retryCount > 0) {
          console.log(`[InitialSync] ${operationName} succeeded on attempt ${retryCount + 1}`);
        }
        return result;
      } catch (error) {
        retryCount++;
        console.error(`[InitialSync] ${operationName} failed (attempt ${retryCount}/${maxRetries}):`, {
          error: error.message,
          vaultId: this.currentVaultId
        });

        // Check if user cancelled
        if (this.cancelRequested) {
          console.log(`[InitialSync] ${operationName} cancelled by user during retry`);
          throw new Error('Operation cancelled by user');
        }

        // Emit retry event
        this.eventBus.emit('initial-sync:retry', {
          operation: operationName,
          attempt: retryCount,
          maxAttempts: maxRetries,
          error: error.message
        });

        if (retryCount >= maxRetries) {
          console.error(`[InitialSync] ${operationName} failed after ${maxRetries} attempts, giving up`);
          throw error;
        }

        // Exponential backoff
        const delay = retryDelay * Math.pow(2, retryCount - 1);
        console.log(`[InitialSync] Retrying ${operationName} in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        
        // Wait with ability to cancel
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, delay);
          
          // Check for cancellation periodically
          const checkCancel = setInterval(() => {
            if (this.cancelRequested) {
              clearTimeout(timeout);
              clearInterval(checkCancel);
              reject(new Error('Operation cancelled by user'));
            }
          }, 100);
          
          setTimeout(() => {
            clearInterval(checkCancel);
          }, delay);
        });
      }
    }

    // This should never be reached, but TypeScript needs it
    throw new Error(`${operationName} failed after ${maxRetries} attempts`);
  }

  /**
   * Compute hash of content for comparison
   *
   * @param content - File content
   * @returns Hash string
   * @private
   */
  private async computeHash(content: string): Promise<string> {
    // Use SubtleCrypto API for SHA-256 hash
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
  }

  /**
   * Create batches from an array of items
   *
   * @param items - Array of items to batch
   * @param batchSize - Size of each batch
   * @returns Array of batches
   * @private
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Request cancellation of current operation
   */
  cancelOperation(): void {
    logger.debug('[InitialSync] Cancellation requested:', {
      vaultId: this.currentVaultId,
      isAnalyzing: this.isAnalyzing,
      isSyncing: this.isSyncing
    });
    this.cancelRequested = true;
  }

  /**
   * Check if an operation is currently in progress
   */
  isOperationInProgress(): boolean {
    const inProgress = this.isAnalyzing || this.isSyncing;
    if (inProgress) {
      logger.debug('[InitialSync] Operation in progress:', {
        vaultId: this.currentVaultId,
        isAnalyzing: this.isAnalyzing,
        isSyncing: this.isSyncing
      });
    }
    return inProgress;
  }
}
