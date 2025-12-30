import { TFile, Vault, TAbstractFile } from 'obsidian';
import { APIClient } from '../api/APIClient';
import { EventBus, EVENTS } from '../core/EventBus';
import { StorageManager } from '../core/StorageManager';
import { ConflictInfo, ConflictType, ConflictResolution, ResolutionStrategy } from '../types';

/**
 * Service for detecting and managing file conflicts
 */
export class ConflictService {
  private vault: Vault;
  private apiClient: APIClient;
  private eventBus: EventBus;
  private storage: StorageManager;
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
    storage: StorageManager
  ) {
    this.vault = vault;
    this.apiClient = apiClient;
    this.eventBus = eventBus;
    this.storage = storage;
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
    
    // Load conflicts from storage
    await this.loadConflicts();
    
    console.debug('ConflictService initialized for vault:', vaultId, {
      isCrossTenant,
      permission
    });
  }

  /**
   * Load conflicts from storage
   */
  private async loadConflicts(): Promise<void> {
    try {
      const storedConflicts = await this.storage.get<ConflictInfo[]>('conflicts');
      if (storedConflicts && Array.isArray(storedConflicts)) {
        this.conflicts = new Map(
          storedConflicts.map(c => [c.id, {
            ...c,
            localModified: new Date(c.localModified),
            remoteModified: new Date(c.remoteModified)
          }])
        );
        console.debug(`Loaded ${this.conflicts.size} conflicts from storage`);
      }
    } catch (error) {
      console.error('Failed to load conflicts:', error);
    }
  }

  /**
   * Save conflicts to storage
   */
  private async saveConflicts(): Promise<void> {
    try {
      const conflictsArray = Array.from(this.conflicts.values());
      await this.storage.set('conflicts', conflictsArray);
    } catch (error) {
      console.error('Failed to save conflicts:', error);
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
              detectedConflicts.push(conflict);
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
   * Check if a specific file has a conflict
   */
  async checkFileConflict(
    localFile: TFile,
    remoteHash: string,
    remoteModified: Date
  ): Promise<ConflictInfo | null> {
    try {
      // Read local content and compute hash
      const localContent = await this.vault.read(localFile);
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
      const localModified = new Date(localFile.stat.mtime);
      const lastSync = new Date(lastSyncTime);

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
   * Create a content conflict record
   */
  private async createContentConflict(
    localFile: TFile,
    localContent: string,
    remoteHash: string,
    remoteModified: Date
  ): Promise<ConflictInfo> {
    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    // Fetch remote content
    const remoteFile = await this.apiClient.getFileByPath(this.vaultId, localFile.path);

    const conflict: ConflictInfo = {
      id: this.generateConflictId(),
      path: localFile.path,
      localContent,
      remoteContent: remoteFile.content,
      localModified: new Date(localFile.stat.mtime),
      remoteModified,
      conflictType: ConflictType.CONTENT,
      autoResolvable: this.isAutoResolvable(localContent, remoteFile.content)
    };

    // Store conflict
    this.conflicts.set(conflict.id, conflict);
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
  ): Promise<ConflictInfo> {
    if (!this.vaultId) {
      throw new Error('Vault not initialized');
    }

    // Fetch remote content
    const remoteFile = await this.apiClient.getFileByPath(this.vaultId, filePath);

    const conflict: ConflictInfo = {
      id: this.generateConflictId(),
      path: filePath,
      localContent: '', // File deleted locally
      remoteContent: remoteFile.content,
      localModified: new Date(), // Deletion time
      remoteModified,
      conflictType: ConflictType.DELETION,
      autoResolvable: false // Deletion conflicts require manual resolution
    };

    // Store conflict
    this.conflicts.set(conflict.id, conflict);
    await this.saveConflicts();

    // Emit event
    this.eventBus.emit(EVENTS.CONFLICT_DETECTED, conflict);

    console.debug(`Deletion conflict detected: ${filePath}`);
    return conflict;
  }

  /**
   * Check if conflict is auto-resolvable
   */
  private isAutoResolvable(localContent: string, remoteContent: string): boolean {
    // Simple heuristic: if one version is a subset of the other, it might be auto-resolvable
    // For now, we'll mark all conflicts as not auto-resolvable to be safe
    return false;
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
          throw new Error(`Unknown resolution strategy: ${resolution.strategy}`);
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
    const parts = originalPath.split('.');
    const ext = parts.pop();
    const base = parts.join('.');
    return `${base}.conflict-${timestamp}.${ext}`;
  }
}
