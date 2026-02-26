import { TFile, Vault } from 'obsidian';
import { APIClient } from '../api/APIClient';
import { EventBus, EVENTS } from '../core/EventBus';
import { StorageManager } from '../core/StorageManager';
import { ConflictInfo, ConflictType, ConflictResolution, ResolutionStrategy } from '../types';
import { FileSyncService } from './FileSyncService';

const MAX_CONFLICTS = 50;
const STALE_CONFLICT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Service for detecting and managing file conflicts
 */
export class ConflictService {
  private vault: Vault;
  private apiClient: APIClient;
  private eventBus: EventBus;
  private storage: StorageManager;
  private fileSyncService: FileSyncService | null = null;
  private vaultId: string | null = null;

  // Track conflicts
  private conflicts: Map<string, ConflictInfo> = new Map();

  // Cross-tenant vault info
  private isCrossTenant: boolean = false;
  private vaultPermission: 'read' | 'write' | 'admin' = 'admin';

  constructor(
    vault: Vault,
    apiClient: APIClient,
    eventBus: EventBus,
    storage: StorageManager,
    fileSyncService?: FileSyncService
  ) {
    this.vault = vault;
    this.apiClient = apiClient;
    this.eventBus = eventBus;
    this.storage = storage;
    this.fileSyncService = fileSyncService || null;
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

    // Load conflicts from storage (includes migration + cleanup)
    await this.loadConflicts();

    console.debug('ConflictService initialized for vault:', vaultId, {
      isCrossTenant,
      permission
    });
  }

  /**
   * Load conflicts from storage, migrating bloated data and cleaning up stale entries
   */
  private async loadConflicts(): Promise<void> {
    try {
      const storedConflicts = await this.storage.get<ConflictInfo[]>('conflicts');
      if (storedConflicts && Array.isArray(storedConflicts)) {
        let needsMigration = false;
        this.conflicts = new Map(
          storedConflicts.map(c => {
            if (c.localContent || c.remoteContent) needsMigration = true;
            return [c.id, {
              ...c,
              localContent: undefined,
              remoteContent: undefined,
              localModified: new Date(c.localModified),
              remoteModified: new Date(c.remoteModified)
            }];
          })
        );
        this.cleanupStaleConflicts();
        if (needsMigration) {
          console.debug('Migrating bloated conflict data — stripping stored content');
          await this.saveConflicts();
        }
        console.debug(`Loaded ${this.conflicts.size} conflicts from storage`);
      }
    } catch (error) {
      console.error('Failed to load conflicts:', error);
    }
  }

  /**
   * Save conflicts to storage — content is always stripped before persistence
   */
  private async saveConflicts(): Promise<void> {
    try {
      const conflictsArray = Array.from(this.conflicts.values()).map(c => ({
        ...c,
        localContent: undefined,
        remoteContent: undefined
      }));
      await this.storage.set('conflicts', conflictsArray);
    } catch (error) {
      console.error('Failed to save conflicts:', error);
    }
  }

  /**
   * Remove conflicts older than STALE_CONFLICT_MS and enforce cap
   */
  private cleanupStaleConflicts(): void {
    const now = Date.now();
    for (const [id, conflict] of this.conflicts) {
      if (now - new Date(conflict.localModified).getTime() > STALE_CONFLICT_MS) {
        this.conflicts.delete(id);
      }
    }
    this.enforceConflictCap();
  }

  /**
   * Evict oldest conflicts when over MAX_CONFLICTS
   */
  private enforceConflictCap(): void {
    if (this.conflicts.size <= MAX_CONFLICTS) return;
    const sorted = Array.from(this.conflicts.entries())
      .sort((a, b) => new Date(a[1].localModified).getTime() - new Date(b[1].localModified).getTime());
    while (this.conflicts.size > MAX_CONFLICTS) {
      const [oldestId] = sorted.shift()!;
      this.conflicts.delete(oldestId);
    }
  }

  /**
   * Remove any existing conflict for the same path (dedup)
   */
  private deduplicateByPath(path: string): void {
    for (const [id, existing] of this.conflicts) {
      if (existing.path === path) {
        this.conflicts.delete(id);
      }
    }
  }

  /**
   * Detect all conflicts in the vault
   */
  async detectConflicts(): Promise<ConflictInfo[]> {
    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    const detectedConflicts: ConflictInfo[] = [];

    try {
      console.debug('Detecting conflicts...');

      // Get all remote files
      const remoteFiles = await this.apiClient.listFiles(this.vaultId);
      const remoteFileMap = new Map(remoteFiles.map(f => [f.path, f]));

      // Get all local files
      const localFiles = this.vault.getMarkdownFiles();

      // Check each local file for conflicts
      for (const localFile of localFiles) {
        const remoteFile = remoteFileMap.get(localFile.path);

        if (remoteFile) {
          // File exists both locally and remotely
          const conflict = await this.checkFileConflict(
            localFile,
            remoteFile.hash,
            remoteFile.updated_at
          );

          if (conflict) {
            detectedConflicts.push(conflict);
          }
        }
      }

      // Check for deletion conflicts (files that exist remotely but not locally)
      for (const remoteFile of remoteFiles) {
        const localFile = this.vault.getAbstractFileByPath(remoteFile.path);

        if (!localFile) {
          // File exists remotely but not locally - potential deletion conflict
          const lastSyncTimestamp = await this.storage.get<Record<string, number>>('lastSyncTimestamps');
          const wasTracked = lastSyncTimestamp && lastSyncTimestamp[remoteFile.path];

          if (wasTracked) {
            // File was previously synced but now deleted locally
            // Check if remote was also modified since last sync
            const lastSync = new Date(lastSyncTimestamp[remoteFile.path]);
            const remoteModified = new Date(remoteFile.updated_at);

            if (remoteModified > lastSync) {
              // Remote was modified after local deletion - conflict
              const conflict = await this.createDeletionConflict(
                remoteFile.path,
                remoteFile.hash,
                remoteModified
              );
              if (conflict) {
                detectedConflicts.push(conflict);
              }
            }
          }
        }
      }

      console.debug(`Detected ${detectedConflicts.length} conflicts`);
      return detectedConflicts;
    } catch (error) {
      console.error('Error detecting conflicts:', error);
      throw error;
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
   * Check if a specific file has a conflict
   */
  async checkFileConflict(
    localFile: TFile,
    remoteHash: string,
    remoteModified: Date
  ): Promise<ConflictInfo | null> {
    try {
      // Read local content using the same binary-aware logic as FileSyncService
      let localContent: string;
      if (this.isBinaryFile(localFile.path)) {
        const arrayBuffer = await this.vault.readBinary(localFile);
        localContent = this.arrayBufferToBase64(arrayBuffer);
      } else {
        localContent = await this.vault.read(localFile);
      }
      const localHash = await this.computeHash(localContent);

      // If hashes match, no conflict
      if (localHash === remoteHash) {
        return null;
      }

      // Check if file was synced before
      const lastSyncTimestamps = await this.storage.get<Record<string, number>>('lastSyncTimestamps');
      const fileHashes = await this.storage.get<Record<string, string>>('fileHashes');

      const lastSyncTime = lastSyncTimestamps?.[localFile.path];
      const lastSyncHash = fileHashes?.[localFile.path];

      // If no sync history, this is a new file conflict
      if (!lastSyncTime || !lastSyncHash) {
        // Both local and remote exist but never synced - conflict
        return await this.createContentConflict(
          localFile,
          localContent,
          remoteHash,
          remoteModified
        );
      }

      // Check if both local and remote changed since last sync
      const localChanged = localHash !== lastSyncHash;
      const remoteChanged = remoteHash !== lastSyncHash;

      if (localChanged && remoteChanged) {
        // Both changed - definite conflict
        return await this.createContentConflict(
          localFile,
          localContent,
          remoteHash,
          remoteModified
        );
      }

      // Only one side changed - no conflict
      return null;
    } catch (error) {
      console.error(`Error checking conflict for ${localFile.path}:`, error);
      return null;
    }
  }

  /**
   * Create a content conflict record.
   * Returns null if content is identical (auto-resolved).
   */
  private async createContentConflict(
    localFile: TFile,
    localContent: string,
    remoteHash: string,
    remoteModified: Date
  ): Promise<ConflictInfo | null> {
    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    // Fetch remote content
    const remoteFile = await this.apiClient.getFileByPath(this.vaultId, localFile.path);
    const localHash = await this.computeHash(localContent);

    // Auto-resolve if content is identical
    if (this.isAutoResolvable(localContent, remoteFile.content)) {
      await this.updateSyncState(localFile.path, localContent);
      console.debug(`Auto-resolved identical content conflict: ${localFile.path}`);
      return null;
    }

    // Dedup: remove any existing conflict for this path
    this.deduplicateByPath(localFile.path);

    const conflict: ConflictInfo = {
      id: this.generateConflictId(),
      path: localFile.path,
      localContent,
      remoteContent: remoteFile.content,
      localHash,
      remoteHash,
      localModified: new Date(localFile.stat.mtime),
      remoteModified,
      conflictType: ConflictType.CONTENT,
      autoResolvable: false
    };

    // Store conflict
    this.conflicts.set(conflict.id, conflict);
    this.enforceConflictCap();
    await this.saveConflicts();

    // Emit event
    this.eventBus.emit(EVENTS.CONFLICT_DETECTED, conflict);

    console.debug(`Content conflict detected: ${localFile.path}`);
    return conflict;
  }

  /**
   * Create a deletion conflict record
   */
  private async createDeletionConflict(
    filePath: string,
    remoteHash: string,
    remoteModified: Date
  ): Promise<ConflictInfo | null> {
    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    // Fetch remote content (kept in memory only for potential UI display)
    const remoteFile = await this.apiClient.getFileByPath(this.vaultId, filePath);

    // Dedup: remove any existing conflict for this path
    this.deduplicateByPath(filePath);

    const conflict: ConflictInfo = {
      id: this.generateConflictId(),
      path: filePath,
      localContent: '', // File deleted locally
      remoteContent: remoteFile.content,
      localHash: undefined,
      remoteHash,
      localModified: new Date(), // Deletion time
      remoteModified,
      conflictType: ConflictType.DELETION,
      autoResolvable: false // Deletion conflicts require manual resolution
    };

    // Store conflict
    this.conflicts.set(conflict.id, conflict);
    this.enforceConflictCap();
    await this.saveConflicts();

    // Emit event
    this.eventBus.emit(EVENTS.CONFLICT_DETECTED, conflict);

    console.debug(`Deletion conflict detected: ${filePath}`);
    return conflict;
  }

  /**
   * Check if conflict is auto-resolvable (identical content after normalization)
   */
  private isAutoResolvable(localContent: string, remoteContent: string): boolean {
    if (localContent === remoteContent) return true;
    if (!localContent || !remoteContent) return false;
    // Normalize line endings and trailing whitespace — Obsidian and the server
    // can produce invisible differences (CRLF vs LF, trailing newlines)
    const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
    return normalize(localContent) === normalize(remoteContent);
  }

  /**
   * Fetch conflict content on-demand for UI display.
   * Returns in-memory content if available, otherwise reads from vault/API.
   */
  async getConflictContent(conflictId: string): Promise<{ localContent: string; remoteContent: string }> {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict || !this.vaultId) throw new Error('Conflict not found');

    // If content is still in memory (freshly created conflict), return it
    if (conflict.localContent !== undefined && conflict.remoteContent !== undefined) {
      return { localContent: conflict.localContent, remoteContent: conflict.remoteContent };
    }

    // Otherwise, fetch on demand
    const localFile = this.vault.getAbstractFileByPath(conflict.path);
    const localContent = localFile instanceof TFile ? await this.vault.read(localFile) : '';

    let remoteContent = '';
    try {
      const remoteFile = await this.apiClient.getFileByPath(this.vaultId, conflict.path);
      remoteContent = remoteFile.content;
    } catch (error) {
      console.error(`Failed to fetch remote content for ${conflict.path}:`, error);
    }

    return { localContent, remoteContent };
  }

  /**
   * Generate unique conflict ID
   */
  private generateConflictId(): string {
    return `conflict_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Compute file hash
   */
  private async computeHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Get all conflicts
   */
  getConflicts(): ConflictInfo[] {
    return Array.from(this.conflicts.values());
  }

  /**
   * Get conflict by ID
   */
  getConflict(conflictId: string): ConflictInfo | null {
    return this.conflicts.get(conflictId) || null;
  }

  /**
   * Get conflicts for a specific file
   */
  getConflictsForFile(filePath: string): ConflictInfo[] {
    return Array.from(this.conflicts.values()).filter(c => c.path === filePath);
  }

  /**
   * Check if file has conflicts
   */
  hasConflicts(filePath: string): boolean {
    return this.getConflictsForFile(filePath).length > 0;
  }

  /**
   * Get conflict count
   */
  getConflictCount(): number {
    return this.conflicts.size;
  }

  /**
   * Clear resolved conflicts
   */
  async clearResolvedConflicts(): Promise<void> {
    // This method can be called after conflicts are resolved
    // For now, conflicts are removed individually when resolved
    await this.saveConflicts();
  }

  /**
   * Remove conflict
   */
  async removeConflict(conflictId: string): Promise<void> {
    this.conflicts.delete(conflictId);
    await this.saveConflicts();

    this.eventBus.emit(EVENTS.CONFLICT_RESOLVED, { conflictId });
  }

  /**
   * Clear all conflicts
   */
  async clearAllConflicts(): Promise<void> {
    this.conflicts.clear();
    await this.saveConflicts();
  }

  /**
   * Resolve a conflict with the specified strategy
   */
  async resolveConflict(
    conflictId: string,
    resolution: ConflictResolution
  ): Promise<void> {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict) {
      throw new Error(`Conflict not found: ${conflictId}`);
    }

    console.debug(`Resolving conflict ${conflictId} with strategy: ${resolution.strategy}`);

    // For cross-tenant vaults, always use remote as source of truth
    if (this.isCrossTenant) {
      console.debug('Cross-tenant vault detected - using remote as source of truth');

      // If read-only permission, always keep remote
      if (this.vaultPermission === 'read') {
        console.debug('Read-only permission - forcing KEEP_REMOTE strategy');
        resolution = { strategy: ResolutionStrategy.KEEP_REMOTE };
      } else if (resolution.strategy === ResolutionStrategy.KEEP_LOCAL) {
        // For write permission, warn but allow if explicitly chosen
        console.warn('Cross-tenant vault: keeping local version may cause sync issues');
      }
    }

    try {
      switch (resolution.strategy) {
        case ResolutionStrategy.KEEP_LOCAL:
          await this.resolveKeepLocal(conflict);
          break;

        case ResolutionStrategy.KEEP_REMOTE:
          await this.resolveKeepRemote(conflict);
          break;

        case ResolutionStrategy.KEEP_BOTH:
          await this.resolveKeepBoth(conflict);
          break;

        case ResolutionStrategy.MERGE_MANUAL:
          await this.resolveMergeManual(conflict, resolution.mergedContent);
          break;

        default:
          throw new Error(`Unknown resolution strategy: ${String(resolution.strategy)}`);
      }

      // Remove conflict after successful resolution
      await this.removeConflict(conflictId);

      console.debug(`Conflict ${conflictId} resolved successfully`);
    } catch (error) {
      console.error(`Failed to resolve conflict ${conflictId}:`, error);
      throw error;
    }
  }

  /**
   * Resolve conflict by keeping local version
   */
  private async resolveKeepLocal(conflict: ConflictInfo): Promise<void> {
    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    console.debug(`Keeping local version for ${conflict.path}`);

    // Get the local file
    const localFile = this.vault.getAbstractFileByPath(conflict.path);

    if (localFile instanceof TFile) {
      // Upload local version to remote
      const content = await this.vault.read(localFile);

      // Check if remote file exists
      const exists = await this.apiClient.fileExists(this.vaultId, conflict.path);

      if (exists) {
        // Update remote file
        const remoteFile = await this.apiClient.getFileByPath(this.vaultId, conflict.path);
        await this.apiClient.updateFile(this.vaultId, remoteFile.file_id, { content });
      } else {
        // Create remote file
        await this.apiClient.createFile(this.vaultId, {
          path: conflict.path,
          content
        });
      }

      // Update sync state
      await this.updateSyncState(conflict.path, content);
    } else if (conflict.conflictType === ConflictType.DELETION) {
      // Local file was deleted, delete from remote too
      const remoteFile = await this.apiClient.getFileByPath(this.vaultId, conflict.path);
      await this.apiClient.deleteFile(this.vaultId, remoteFile.file_id);

      // Clear sync state
      await this.clearFileSyncState(conflict.path);
    } else {
      throw new Error(`Local file not found: ${conflict.path}`);
    }
  }

  /**
   * Resolve conflict by keeping remote version
   */
  private async resolveKeepRemote(conflict: ConflictInfo): Promise<void> {
    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    console.debug(`Keeping remote version for ${conflict.path}`);

    // Get remote file
    const remoteFile = await this.apiClient.getFileByPath(this.vaultId, conflict.path);

    // Get local file
    const localFile = this.vault.getAbstractFileByPath(conflict.path);

    if (localFile instanceof TFile) {
      // Update local file with remote content
      await this.vault.modify(localFile, remoteFile.content);
    } else {
      // Create local file with remote content
      await this.vault.create(conflict.path, remoteFile.content);
    }

    // Update sync state
    await this.updateSyncState(conflict.path, remoteFile.content);
  }

  /**
   * Resolve conflict by keeping both versions
   */
  private async resolveKeepBoth(conflict: ConflictInfo): Promise<void> {
    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    console.debug(`Keeping both versions for ${conflict.path}`);

    // Generate conflict copy path
    const conflictCopyPath = this.generateConflictCopyPath(conflict.path);

    // Get local file
    const localFile = this.vault.getAbstractFileByPath(conflict.path);

    if (localFile instanceof TFile) {
      // Read local content
      const localContent = await this.vault.read(localFile);

      // Create conflict copy with local content
      await this.vault.create(conflictCopyPath, localContent);

      // Update original file with remote content
      const remoteFile = await this.apiClient.getFileByPath(this.vaultId, conflict.path);
      await this.vault.modify(localFile, remoteFile.content);

      // Update sync state for original file
      await this.updateSyncState(conflict.path, remoteFile.content);

      console.debug(`Created conflict copy: ${conflictCopyPath}`);
    } else {
      throw new Error(`Local file not found: ${conflict.path}`);
    }
  }

  /**
   * Resolve conflict with manually merged content
   */
  private async resolveMergeManual(
    conflict: ConflictInfo,
    mergedContent?: string
  ): Promise<void> {
    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    if (!mergedContent) {
      throw new Error('Merged content is required for manual merge');
    }

    console.debug(`Applying manual merge for ${conflict.path}`);

    // Get local file
    const localFile = this.vault.getAbstractFileByPath(conflict.path);

    if (localFile instanceof TFile) {
      // Update local file with merged content
      await this.vault.modify(localFile, mergedContent);
    } else {
      // Create local file with merged content
      await this.vault.create(conflict.path, mergedContent);
    }

    // Upload merged content to remote
    const exists = await this.apiClient.fileExists(this.vaultId, conflict.path);

    if (exists) {
      const remoteFile = await this.apiClient.getFileByPath(this.vaultId, conflict.path);
      await this.apiClient.updateFile(this.vaultId, remoteFile.file_id, {
        content: mergedContent
      });
    } else {
      await this.apiClient.createFile(this.vaultId, {
        path: conflict.path,
        content: mergedContent
      });
    }

    // Update sync state
    await this.updateSyncState(conflict.path, mergedContent);
  }

  /**
   * Resolve all conflicts with a single strategy
   */
  async resolveAllConflicts(strategy: ResolutionStrategy): Promise<void> {
    const conflicts = Array.from(this.conflicts.values());

    console.debug(`Resolving ${conflicts.length} conflicts with strategy: ${strategy}`);

    const errors: Array<{ conflictId: string; error: string }> = [];

    for (const conflict of conflicts) {
      try {
        await this.resolveConflict(conflict.id, { strategy });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ conflictId: conflict.id, error: errorMessage });
        console.error(`Failed to resolve conflict ${conflict.id}:`, error);
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Failed to resolve ${errors.length} conflict(s): ${errors.map(e => e.error).join(', ')}`
      );
    }

    console.debug('All conflicts resolved successfully');
  }

  /**
   * Update sync state after resolution
   */
  private async updateSyncState(filePath: string, content: string): Promise<void> {
    const hash = await this.computeHash(content);
    const timestamp = Date.now();

    // Update timestamps
    const lastSyncTimestamps = await this.storage.get<Record<string, number>>('lastSyncTimestamps') || {};
    lastSyncTimestamps[filePath] = timestamp;
    await this.storage.set('lastSyncTimestamps', lastSyncTimestamps);

    // Update hashes
    const fileHashes = await this.storage.get<Record<string, string>>('fileHashes') || {};
    fileHashes[filePath] = hash;
    await this.storage.set('fileHashes', fileHashes);

    // Also update FileSyncService in-memory state to prevent stale reads on next sync cycle
    if (this.fileSyncService) {
      this.fileSyncService.updateFileHash(filePath, hash);
    }

    console.debug(`Updated sync state for ${filePath}`);
  }

  /**
   * Clear sync state for a file
   */
  private async clearFileSyncState(filePath: string): Promise<void> {
    // Clear timestamps
    const lastSyncTimestamps = await this.storage.get<Record<string, number>>('lastSyncTimestamps') || {};
    delete lastSyncTimestamps[filePath];
    await this.storage.set('lastSyncTimestamps', lastSyncTimestamps);

    // Clear hashes
    const fileHashes = await this.storage.get<Record<string, string>>('fileHashes') || {};
    delete fileHashes[filePath];
    await this.storage.set('fileHashes', fileHashes);

    console.debug(`Cleared sync state for ${filePath}`);
  }

  /**
   * Generate conflict copy path
   */
  private generateConflictCopyPath(originalPath: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const dotIndex = originalPath.lastIndexOf('.');

    // Handle extensionless files — avoid creating hidden files like ".conflict-..."
    if (dotIndex <= 0 || dotIndex <= originalPath.lastIndexOf('/')) {
      // No extension (or dot is part of a directory name), append suffix directly
      return `${originalPath}.conflict-${timestamp}`;
    }

    const base = originalPath.substring(0, dotIndex);
    const ext = originalPath.substring(dotIndex); // includes the dot
    return `${base}.conflict-${timestamp}${ext}`;
  }
}
