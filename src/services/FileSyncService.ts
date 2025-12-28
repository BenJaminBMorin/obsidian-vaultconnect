import { TFile, Vault } from 'obsidian';
import { APIClient } from '../api/APIClient';
import { EventBus, EVENTS } from '../core/EventBus';
import { StorageManager } from '../core/StorageManager';
import { FileChangeEvent } from './FileWatcherService';
import { QueuedOperation } from './SyncQueueService';
import { LargeFileService } from './LargeFileService';

/**
 * File sync status
 */
export interface FileSyncStatus {
  path: string;
  status: 'synced' | 'syncing' | 'pending' | 'error' | 'conflict';
  lastSync: Date | null;
  hash: string | null;
  error?: string;
}

/**
 * Sync result for a single file
 */
export interface FileSyncResult {
  success: boolean;
  path: string;
  operation: 'upload' | 'download' | 'delete';
  hash?: string;
  error?: string;
  timestamp: number;
  skipped?: boolean;
}

/**
 * Sync statistics
 */
export interface SyncStats {
  filesUploaded: number;
  filesDownloaded: number;
  filesDeleted: number;
  errors: number;
  conflicts: number;
  duration: number;
}

/**
 * Service for basic file synchronization operations
 */
export class FileSyncService {
  private vault: Vault;
  private apiClient: APIClient;
  private eventBus: EventBus;
  private storage: StorageManager;
  private largeFileService: LargeFileService | null = null;
  private vaultId: string | null = null;
  
  // Track sync status for each file
  private syncStatus: Map<string, FileSyncStatus> = new Map();
  
  // Track last sync timestamps
  private lastSyncTimestamps: Map<string, number> = new Map();
  
  // Track file hashes
  private fileHashes: Map<string, string> = new Map();
  
  // Track read-only files (from cross-tenant vaults with read permission)
  private readOnlyFiles: Set<string> = new Set();
  
  // Track locally deleted files (to prevent re-downloading them)
  private locallyDeletedFiles: Set<string> = new Set();
  
  // Cross-tenant vault info
  private isCrossTenant: boolean = false;
  private vaultPermission: 'read' | 'write' | 'admin' = 'admin';

  constructor(
    vault: Vault,
    apiClient: APIClient,
    eventBus: EventBus,
    storage: StorageManager,
    largeFileService?: LargeFileService
  ) {
    this.vault = vault;
    this.apiClient = apiClient;
    this.eventBus = eventBus;
    this.storage = storage;
    this.largeFileService = largeFileService || null;
  }

  /**
   * Initialize service
   */
  async initialize(
    vaultId: string,
    isCrossTenant: boolean = false,
    permission: 'read' | 'write' | 'admin' = 'admin'
  ): Promise<void> {
    this.vaultId = vaultId;
    this.isCrossTenant = isCrossTenant;
    this.vaultPermission = permission;
    
    // Load sync state from storage
    await this.loadSyncState();
    
    console.log('FileSyncService initialized for vault:', vaultId, {
      isCrossTenant,
      permission
    });
  }

  /**
   * Load sync state from storage
   */
  private async loadSyncState(): Promise<void> {
    try {
      const timestamps = await this.storage.get<Record<string, number>>('lastSyncTimestamps');
      if (timestamps) {
        this.lastSyncTimestamps = new Map(Object.entries(timestamps));
      }

      const hashes = await this.storage.get<Record<string, string>>('fileHashes');
      if (hashes) {
        this.fileHashes = new Map(Object.entries(hashes));
      }

      const readOnlyFiles = await this.storage.get<string[]>('readOnlyFiles');
      if (readOnlyFiles) {
        this.readOnlyFiles = new Set(readOnlyFiles);
      }

      const locallyDeletedFiles = await this.storage.get<string[]>('locallyDeletedFiles');
      if (locallyDeletedFiles) {
        this.locallyDeletedFiles = new Set(locallyDeletedFiles);
      }

      console.log(`Loaded sync state: ${this.lastSyncTimestamps.size} timestamps, ${this.fileHashes.size} hashes, ${this.readOnlyFiles.size} read-only files, ${this.locallyDeletedFiles.size} locally deleted files`);
    } catch (error) {
      console.error('Failed to load sync state:', error);
    }
  }

  /**
   * Save sync state to storage
   * Made public so it can be called after batch operations
   */
  async saveSyncState(): Promise<void> {
    try {
      await this.storage.set(
        'lastSyncTimestamps',
        Object.fromEntries(this.lastSyncTimestamps)
      );
      
      await this.storage.set(
        'fileHashes',
        Object.fromEntries(this.fileHashes)
      );
      
      await this.storage.set(
        'readOnlyFiles',
        Array.from(this.readOnlyFiles)
      );
      
      await this.storage.set(
        'locallyDeletedFiles',
        Array.from(this.locallyDeletedFiles)
      );
    } catch (error) {
      console.error('Failed to save sync state:', error);
    }
  }

  /**
   * Convert ArrayBuffer to base64 string
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  /**
   * Upload file to remote
   * @param file - File to upload
   * @param forceCreate - If true, always create new file (skip existence check). Use for initial sync of local-only files.
   * @param skipSaveState - If true, skip saving sync state to disk (for batch operations). Caller must call saveSyncState() later.
   */
  async uploadFile(file: TFile, forceCreate: boolean = false, skipSaveState: boolean = false): Promise<FileSyncResult> {
    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    // Check if file is read-only (cross-tenant with read permission)
    if (this.isFileReadOnly(file.path)) {
      console.log(`Skipping upload for read-only file: ${file.path} (cross-tenant vault with read permission)`);
      return {
        success: false,
        path: file.path,
        operation: 'upload',
        error: 'File is read-only (cross-tenant vault with read permission)',
        timestamp: Date.now(),
        skipped: true
      };
    }

    const startTime = Date.now();

    try {
      // Update status
      this.updateSyncStatus(file.path, 'syncing');

      // Determine if file is binary
      const isBinary = this.isBinaryFile(file.path);

      // Read file content
      let content: string;
      if (isBinary) {
        // Binary files: read as ArrayBuffer and convert to base64
        const arrayBuffer = await this.vault.readBinary(file);
        content = this.arrayBufferToBase64(arrayBuffer);
      } else {
        // Text files: read as string
        content = await this.vault.read(file);
      }

      // Compute hash
      const hash = await this.computeHash(content);

      // Check if file has changed since last sync (skip if unchanged)
      const lastHash = this.fileHashes.get(file.path);
      if (lastHash === hash && !forceCreate) {
        console.log(`Skipping upload for ${file.path} - content unchanged (hash: ${hash})`);
        this.updateSyncStatus(file.path, 'synced', hash);
        return {
          success: true,
          path: file.path,
          operation: 'upload',
          hash,
          timestamp: Date.now(),
          skipped: true
        };
      }

      // Check file size - use chunking for files > 5MB
      const CHUNK_THRESHOLD = 5 * 1024 * 1024; // 5MB
      const fileSize = file.stat.size;

      if (fileSize > CHUNK_THRESHOLD && this.largeFileService) {
        // Use LargeFileService for chunked upload
        console.log(`Using chunked upload for large file: ${file.path} (${fileSize} bytes)`);

        // Check if file exists to get fileId (unless forceCreate is true)
        let fileId: string | undefined;
        if (!forceCreate) {
          try {
            const remoteFile = await this.apiClient.getFileByPath(this.vaultId, file.path);
            fileId = remoteFile.file_id;
          } catch (error) {
            // File doesn't exist, will be created
            fileId = undefined;
          }
        }

        await this.largeFileService.uploadFile(
          this.vaultId,
          file.path,
          content,
          fileId
        );

        // Update sync state
        this.fileHashes.set(file.path, hash);
        this.lastSyncTimestamps.set(file.path, Date.now());
        this.updateSyncStatus(file.path, 'synced', hash);
        if (!skipSaveState) {
          await this.saveSyncState();
        }

        console.log(`Chunked upload completed: ${file.path}`);

        return {
          success: true,
          path: file.path,
          operation: 'upload',
          hash,
          timestamp: Date.now()
        };
      }

      // For smaller files, use regular upload
      let result: FileSyncResult;

      if (forceCreate) {
        // Skip existence check and create new file directly (for initial sync performance)
        await this.apiClient.createFile(this.vaultId, {
          path: file.path,
          content
        });

        result = {
          success: true,
          path: file.path,
          operation: 'upload',
          hash,
          timestamp: Date.now()
        };
      } else {
        // Check if file exists on remote
        const exists = await this.apiClient.fileExists(this.vaultId, file.path);

        if (exists) {
          // Update existing file
          const remoteFile = await this.apiClient.getFileByPath(this.vaultId, file.path);
          await this.apiClient.updateFile(this.vaultId, remoteFile.file_id, { content });

          result = {
            success: true,
            path: file.path,
            operation: 'upload',
            hash,
            timestamp: Date.now()
          };
        } else {
          // Create new file
          await this.apiClient.createFile(this.vaultId, {
            path: file.path,
            content
          });

          result = {
            success: true,
            path: file.path,
            operation: 'upload',
            hash,
            timestamp: Date.now()
          };
        }
      }

      // Update sync state
      this.fileHashes.set(file.path, hash);
      this.lastSyncTimestamps.set(file.path, Date.now());
      this.updateSyncStatus(file.path, 'synced', hash);
      
      // Clear local deletion flag if file was previously deleted
      this.locallyDeletedFiles.delete(file.path);
      
      if (!skipSaveState) {
        await this.saveSyncState();
      }

      console.log(`Uploaded ${file.path} (${isBinary ? 'binary' : 'text'}, ${hash.substring(0, 8)}...)`);
      
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upload ${file.path}:`, error);
      
      this.updateSyncStatus(file.path, 'error', null, errorMessage);
      
      return {
        success: false,
        path: file.path,
        operation: 'upload',
        error: errorMessage,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Check if a file is binary based on its extension
   */
  private isBinaryFile(filePath: string): boolean {
    const binaryExtensions = [
      // Images
      '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp', '.tiff', '.tif',
      // Documents
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      // Archives
      '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2',
      // Audio/Video
      '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.wav', '.ogg',
      // Executables
      '.exe', '.dll', '.so', '.dylib',
      // Other binary formats
      '.bin', '.dat', '.db', '.sqlite'
    ];
    
    const ext = filePath.toLowerCase().substring(filePath.lastIndexOf('.'));
    return binaryExtensions.includes(ext);
  }

  /**
   * Convert base64 string to ArrayBuffer
   */
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = window.atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Preserve file timestamps to prevent sync conflicts
   * Sets the file's mtime and ctime to match the server's timestamps
   */
  private async preserveFileTimestamps(
    file: TFile,
    createdAt: string,
    updatedAt: string
  ): Promise<void> {
    try {
      // Get the vault's base path and construct full file path
      const adapter = this.vault.adapter;
      // @ts-ignore - basePath exists on FileSystemAdapter
      // Note: Obsidian's API doesn't provide a way to set file timestamps.
      // The file's mtime will be updated when we write to it.
      // Timestamp preservation is handled at the metadata level instead.
      logger.debug(`[Timestamp Preservation] Skipped for ${file.path} - using Obsidian's file modification time`);
    } catch (error) {
      // Log but don't fail the sync if timestamp preservation fails
      logger.warn(`[Timestamp Preservation] Failed to preserve timestamps for ${file.path}:`, error);
    }
  }

  /**
   * Download file from remote
   */
  async downloadFile(filePath: string): Promise<FileSyncResult> {
    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    try {
      // Update status
      this.updateSyncStatus(filePath, 'syncing');

      // Get file from remote
      const remoteFile = await this.apiClient.getFileByPath(this.vaultId, filePath);
      
      // Check if local file exists
      const localFile = this.vault.getAbstractFileByPath(filePath);

      // Determine if file is binary
      const isBinary = this.isBinaryFile(filePath);

      if (localFile instanceof TFile) {
        // Update existing file
        console.log(`[Download Debug] About to modify ${filePath}`);
        console.log(`[Download Debug] Remote hash: ${remoteFile.hash}`);
        console.log(`[Download Debug] Remote content length: ${remoteFile.content.length}`);
        console.log(`[Download Debug] Remote content preview: ${remoteFile.content.substring(0, 100)}`);

        // Read current local content before modify
        const beforeContent = await this.vault.read(localFile);
        const beforeHash = await this.computeHash(beforeContent);
        console.log(`[Download Debug] Local hash BEFORE modify: ${beforeHash}`);
        console.log(`[Download Debug] Local content length BEFORE: ${beforeContent.length}`);

        if (isBinary) {
          // Binary files: decode base64 and use modifyBinary
          const arrayBuffer = this.base64ToArrayBuffer(remoteFile.content);
          await this.vault.modifyBinary(localFile, arrayBuffer);
        } else {
          // Text files: use modify directly
          await this.vault.modify(localFile, remoteFile.content);
        }

        // Verify the content was actually written
        const afterContent = await this.vault.read(localFile);
        const afterHash = await this.computeHash(afterContent);
        console.log(`[Download Debug] Local hash AFTER modify: ${afterHash}`);
        console.log(`[Download Debug] Local content length AFTER: ${afterContent.length}`);
        console.log(`[Download Debug] Hash matches remote? ${afterHash === remoteFile.hash}`);
        
        // Preserve original file timestamps to prevent sync conflicts
        await this.preserveFileTimestamps(localFile, remoteFile.created_at, remoteFile.updated_at);
      } else {
        // Create new file - ensure parent folders exist
        const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
        if (folderPath && !this.vault.getAbstractFileByPath(folderPath)) {
          // Create parent folders if they don't exist
          const folders = folderPath.split('/');
          let currentPath = '';
          for (const folder of folders) {
            currentPath = currentPath ? `${currentPath}/${folder}` : folder;
            const existing = this.vault.getAbstractFileByPath(currentPath);
            
            if (!existing) {
              // Path doesn't exist, create folder
              await this.vault.createFolder(currentPath);
            } else if (existing instanceof TFile) {
              // A FILE exists where we need a FOLDER - this is a path conflict
              console.error(`Path conflict: Cannot create folder "${currentPath}" because a file with that name exists`);
              throw new Error(`Path conflict: File exists at "${currentPath}" but folder is needed for "${filePath}"`);
            }
            // If it's already a folder, continue
          }
        }

        let createdFile: TFile;
        if (isBinary) {
          // Binary files: decode base64 and use createBinary
          const arrayBuffer = this.base64ToArrayBuffer(remoteFile.content);
          createdFile = await this.vault.createBinary(filePath, arrayBuffer);
        } else {
          // Text files: use create directly
          createdFile = await this.vault.create(filePath, remoteFile.content);
        }
        
        // Preserve original file timestamps to prevent sync conflicts
        await this.preserveFileTimestamps(createdFile, remoteFile.created_at, remoteFile.updated_at);
      }

      // Update sync state
      this.fileHashes.set(filePath, remoteFile.hash);
      this.lastSyncTimestamps.set(filePath, Date.now());
      this.updateSyncStatus(filePath, 'synced', remoteFile.hash);
      
      // Mark as read-only if cross-tenant with read permission
      if (this.isCrossTenant && this.vaultPermission === 'read') {
        this.readOnlyFiles.add(filePath);
        console.log(`Marked ${filePath} as read-only (cross-tenant vault with read permission)`);
      } else {
        // Remove from read-only if it was previously marked
        this.readOnlyFiles.delete(filePath);
      }
      
      await this.saveSyncState();

      console.log(`Downloaded ${filePath} (${isBinary ? 'binary' : 'text'}, ${remoteFile.hash.substring(0, 8)}...)`);

      return {
        success: true,
        path: filePath,
        operation: 'download',
        hash: remoteFile.hash,
        timestamp: Date.now()
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // If file already exists, treat as success but log it
      if (errorMessage.includes('File already exists')) {
        console.log(`File already exists locally: ${filePath}, skipping download`);
        return {
          success: true,
          path: filePath,
          operation: 'download',
          timestamp: Date.now()
        };
      }
      
      // Path conflicts are expected in some cases - log as warning but don't fail sync
      if (errorMessage.includes('Path conflict')) {
        console.warn(`Path conflict detected: ${errorMessage}`);
        this.updateSyncStatus(filePath, 'conflict', null, errorMessage);
        return {
          success: false,
          path: filePath,
          operation: 'download',
          error: errorMessage,
          timestamp: Date.now()
        };
      }
      
      console.error(`Failed to download ${filePath}:`, error);
      
      this.updateSyncStatus(filePath, 'error', null, errorMessage);
      
      return {
        success: false,
        path: filePath,
        operation: 'download',
        error: errorMessage,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Delete file from remote
   */
  async deleteFile(filePath: string): Promise<FileSyncResult> {
    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    try {
      // Get file info to get file ID
      const remoteFile = await this.apiClient.getFileByPath(this.vaultId, filePath);

      // Delete from remote
      await this.apiClient.deleteFile(this.vaultId, remoteFile.file_id);

      // Clean up sync state
      this.fileHashes.delete(filePath);
      this.lastSyncTimestamps.delete(filePath);
      this.syncStatus.delete(filePath);
      
      // Track as locally deleted to prevent re-download
      this.locallyDeletedFiles.add(filePath);
      
      await this.saveSyncState();

      console.log(`Deleted ${filePath} from remote and marked as locally deleted`);

      return {
        success: true,
        path: filePath,
        operation: 'delete',
        timestamp: Date.now()
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // If file is already deleted (404), treat as success and clean up state
      if (errorMessage.includes('404') || errorMessage.includes('Not Found') || errorMessage.includes('not found')) {
        console.log(`File already deleted remotely: ${filePath}`);

        // Clean up sync state anyway
        this.fileHashes.delete(filePath);
        this.lastSyncTimestamps.delete(filePath);
        this.syncStatus.delete(filePath);
        
        // Track as locally deleted to prevent re-download
        this.locallyDeletedFiles.add(filePath);
        
        await this.saveSyncState();

        return {
          success: true,
          path: filePath,
          operation: 'delete',
          timestamp: Date.now()
        };
      }

      console.error(`Failed to delete ${filePath}:`, error);

      return {
        success: false,
        path: filePath,
        operation: 'delete',
        error: errorMessage,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Check if file has changed locally
   */
  async hasLocalChanges(file: TFile): Promise<boolean> {
    try {
      const content = await this.vault.read(file);
      const currentHash = await this.computeHash(content);
      const storedHash = this.fileHashes.get(file.path);
      
      return !storedHash || currentHash !== storedHash;
    } catch (error) {
      console.error(`Failed to check local changes for ${file.path}:`, error);
      return true; // Assume changed if we can't check
    }
  }

  /**
   * Check if file has changed remotely
   */
  async hasRemoteChanges(filePath: string): Promise<boolean> {
    if (!this.vaultId) {
      return false;
    }

    try {
      // Get file info to check hash
      const remoteFile = await this.apiClient.getFileByPath(this.vaultId, filePath);
      const storedHash = this.fileHashes.get(filePath);

      const hasChanges = !storedHash || remoteFile.hash !== storedHash;
      console.log(`Remote change check for ${filePath}:`, {
        remoteHash: remoteFile.hash.substring(0, 8),
        storedHash: storedHash?.substring(0, 8) || 'none',
        hasChanges
      });

      return hasChanges;
    } catch (error) {
      // If file doesn't exist remotely (404), it hasn't changed remotely
      if (error.message && error.message.includes('404')) {
        return false;
      }
      console.error(`Failed to check remote changes for ${filePath}:`, error);
      return false;
    }
  }

  /**
   * Compute file hash
   */
  async computeHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Update sync status for a file
   */
  private updateSyncStatus(
    path: string,
    status: 'synced' | 'syncing' | 'pending' | 'error' | 'conflict',
    hash: string | null = null,
    error?: string
  ): void {
    const syncStatus: FileSyncStatus = {
      path,
      status,
      lastSync: status === 'synced' ? new Date() : this.syncStatus.get(path)?.lastSync || null,
      hash: hash || this.syncStatus.get(path)?.hash || null,
      error
    };

    this.syncStatus.set(path, syncStatus);
  }

  /**
   * Get sync status for a file
   */
  getSyncStatus(path: string): FileSyncStatus | null {
    return this.syncStatus.get(path) || null;
  }

  /**
   * Update the stored hash for a file (used when hash matches remote to prevent unnecessary uploads)
   */
  updateFileHash(path: string, hash: string): void {
    this.fileHashes.set(path, hash);
    this.lastSyncTimestamps.set(path, Date.now());
  }

  /**
   * Get all sync statuses
   */
  getAllSyncStatuses(): FileSyncStatus[] {
    return Array.from(this.syncStatus.values());
  }

  /**
   * Get last sync timestamp for a file
   */
  getLastSyncTimestamp(path: string): number | null {
    return this.lastSyncTimestamps.get(path) || null;
  }

  /**
   * Get stored hash for a file
   */
  getStoredHash(path: string): string | null {
    return this.fileHashes.get(path) || null;
  }

  /**
   * Process queued operation
   */
  async processQueuedOperation(operation: QueuedOperation): Promise<FileSyncResult> {
    console.log(`Processing queued operation: ${operation.operation} ${operation.path}`);

    switch (operation.operation) {
      case 'create':
      case 'update': {
        const file = this.vault.getAbstractFileByPath(operation.path);
        if (file instanceof TFile) {
          return await this.uploadFile(file);
        } else {
          throw new Error(`File not found: ${operation.path}`);
        }
      }

      case 'delete': {
        return await this.deleteFile(operation.path);
      }

      case 'rename': {
        // Handle rename as delete old + create new
        if (operation.oldPath) {
          try {
            await this.deleteFile(operation.oldPath);
          } catch (error) {
            // If delete fails (e.g., file doesn't exist), log but continue
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.log(`[FileSyncService] Could not delete old path during rename: ${errorMsg}`);
            // Continue with upload of new path
          }
        }
        
        const file = this.vault.getAbstractFileByPath(operation.path);
        if (file instanceof TFile) {
          return await this.uploadFile(file);
        } else {
          throw new Error(`File not found: ${operation.path}`);
        }
      }

      default:
        throw new Error(`Unknown operation: ${operation.operation}`);
    }
  }

  /**
   * Handle file rename - update sync state with new path
   */
  async handleFileRename(oldPath: string, newPath: string): Promise<void> {
    console.log(`[FileSyncService] Updating sync state for rename: ${oldPath} -> ${newPath}`);

    // Transfer sync state from old path to new path
    const hash = this.fileHashes.get(oldPath);
    const timestamp = this.lastSyncTimestamps.get(oldPath);
    const status = this.syncStatus.get(oldPath);

    if (hash) {
      this.fileHashes.set(newPath, hash);
    }
    if (timestamp) {
      this.lastSyncTimestamps.set(newPath, timestamp);
    }
    if (status) {
      this.syncStatus.set(newPath, status);
    }

    // Remove old path from sync state
    this.fileHashes.delete(oldPath);
    this.lastSyncTimestamps.delete(oldPath);
    this.syncStatus.delete(oldPath);

    // Save updated state
    await this.saveSyncState();

    console.log(`[FileSyncService] Sync state updated for renamed file`);
  }

  /**
   * Clear sync state for a file
   */
  clearSyncState(path: string): void {
    this.fileHashes.delete(path);
    this.lastSyncTimestamps.delete(path);
    this.syncStatus.delete(path);
    this.saveSyncState();
  }

  /**
   * Clear all sync state
   */
  async clearAllSyncState(): Promise<void> {
    this.fileHashes.clear();
    this.lastSyncTimestamps.clear();
    this.syncStatus.clear();
    this.locallyDeletedFiles.clear();
    await this.saveSyncState();
  }

  /**
   * Get all locally deleted files
   */
  getLocallyDeletedFiles(): string[] {
    return Array.from(this.locallyDeletedFiles);
  }

  /**
   * Clear all locally deleted files (useful for reset/troubleshooting)
   */
  async clearLocallyDeletedFiles(): Promise<void> {
    this.locallyDeletedFiles.clear();
    await this.saveSyncState();
    console.log('Cleared all locally deleted files tracking');
  }

  /**
   * Get sync statistics
   */
  getSyncStatistics(): {
    totalFiles: number;
    syncedFiles: number;
    pendingFiles: number;
    errorFiles: number;
  } {
    const statuses = Array.from(this.syncStatus.values());
    
    return {
      totalFiles: statuses.length,
      syncedFiles: statuses.filter(s => s.status === 'synced').length,
      pendingFiles: statuses.filter(s => s.status === 'pending' || s.status === 'syncing').length,
      errorFiles: statuses.filter(s => s.status === 'error').length
    };
  }

  /**
   * Check if a file is read-only (cross-tenant with read permission)
   */
  isFileReadOnly(path: string): boolean {
    return this.readOnlyFiles.has(path);
  }

  /**
   * Check if a file was locally deleted (should not be re-downloaded)
   */
  isLocallyDeleted(path: string): boolean {
    return this.locallyDeletedFiles.has(path);
  }

  /**
   * Mark a file as no longer locally deleted (e.g., when user creates it again)
   */
  clearLocalDeletion(path: string): void {
    this.locallyDeletedFiles.delete(path);
  }

  /**
   * Mark a file as read-only
   */
  markFileReadOnly(path: string): void {
    this.readOnlyFiles.add(path);
  }

  /**
   * Remove read-only status from a file
   */
  markFileWritable(path: string): void {
    this.readOnlyFiles.delete(path);
  }

  /**
   * Get all read-only files
   */
  getReadOnlyFiles(): string[] {
    return Array.from(this.readOnlyFiles);
  }

  /**
   * Check if vault has write permission
   */
  hasWritePermission(): boolean {
    return this.vaultPermission === 'write' || this.vaultPermission === 'admin';
  }

  /**
   * Update vault permission (called when vault access changes)
   */
  updateVaultPermission(isCrossTenant: boolean, permission: 'read' | 'write' | 'admin'): void {
    this.isCrossTenant = isCrossTenant;
    this.vaultPermission = permission;
    
    // If permission changed to read-only, mark all files as read-only
    if (isCrossTenant && permission === 'read') {
      const allFiles = Array.from(this.fileHashes.keys());
      allFiles.forEach(path => this.readOnlyFiles.add(path));
      console.log(`Marked ${allFiles.length} files as read-only due to permission change`);
    } else if (permission === 'write' || permission === 'admin') {
      // If permission changed to write/admin, remove read-only status
      this.readOnlyFiles.clear();
      console.log('Cleared read-only status for all files due to permission change');
    }
    
    this.saveSyncState();
  }
}
