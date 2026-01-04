import { Plugin } from 'obsidian';
import { LocalStorage, QueuedFile, ConflictInfo, ActiveUser, VaultInfo, FileInfo } from '../types';

/**
 * Storage Manager for local data persistence
 */
export class StorageManager {
  private plugin: Plugin;
  private storage: LocalStorage;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.storage = this.getDefaultStorage();
  }

  /**
   * Initialize storage
   */
  async initialize(): Promise<void> {
    const data = await this.plugin.loadData();
    if (data?.localStorage) {
      this.storage = {
        ...this.getDefaultStorage(),
        ...data.localStorage
      };
      
      // Convert date strings back to Date objects
      this.storage.lastSyncTimestamp = this.convertDates(this.storage.lastSyncTimestamp);
      this.storage.syncQueue = this.storage.syncQueue.map(item => ({
        ...item,
        timestamp: new Date(item.timestamp)
      }));
      this.storage.conflicts = this.storage.conflicts.map(conflict => ({
        ...conflict,
        localModified: new Date(conflict.localModified),
        remoteModified: new Date(conflict.remoteModified)
      }));
      this.storage.activeUsers = this.convertUserDates(this.storage.activeUsers);
    }
  }

  /**
   * Save storage to disk
   */
  async save(): Promise<void> {
    const data = await this.plugin.loadData() || {};
    data.localStorage = this.storage;
    await this.plugin.saveData(data);
  }

  /**
   * Get default storage structure
   */
  private getDefaultStorage(): LocalStorage {
    return {
      lastSyncTimestamp: {},
      fileHashes: {},
      syncQueue: [],
      conflicts: [],
      activeUsers: {},
      fileViewers: {},
      yjsDocuments: {},
      vaultCache: null,
      filesCache: {}
    };
  }

  /**
   * Convert date strings to Date objects
   */
  private convertDates(obj: Record<string, unknown>): Record<string, Date> {
    const result: Record<string, Date> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = new Date(value as string | number | Date);
    }
    return result;
  }

  /**
   * Convert user dates
   */
  private convertUserDates(users: Record<string, unknown>): Record<string, ActiveUser> {
    const result: Record<string, ActiveUser> = {};
    for (const [key, user] of Object.entries(users)) {
      const activeUser = user as ActiveUser;
      result[key] = {
        ...activeUser,
        lastActivity: new Date(activeUser.lastActivity)
      };
    }
    return result;
  }

  // Sync State Methods

  getLastSyncTimestamp(filePath: string): Date | null {
    return this.storage.lastSyncTimestamp[filePath] || null;
  }

  setLastSyncTimestamp(filePath: string, timestamp: Date): void {
    this.storage.lastSyncTimestamp[filePath] = timestamp;
  }

  getFileHash(filePath: string): string | null {
    return this.storage.fileHashes[filePath] || null;
  }

  setFileHash(filePath: string, hash: string): void {
    this.storage.fileHashes[filePath] = hash;
  }

  deleteFileData(filePath: string): void {
    delete this.storage.lastSyncTimestamp[filePath];
    delete this.storage.fileHashes[filePath];
  }

  // Sync Queue Methods

  getSyncQueue(): QueuedFile[] {
    return this.storage.syncQueue;
  }

  addToSyncQueue(file: QueuedFile): void {
    // Remove existing entry for same file
    this.storage.syncQueue = this.storage.syncQueue.filter(
      item => item.path !== file.path
    );
    this.storage.syncQueue.push(file);
  }

  removeFromSyncQueue(filePath: string): void {
    this.storage.syncQueue = this.storage.syncQueue.filter(
      item => item.path !== filePath
    );
  }

  clearSyncQueue(): void {
    this.storage.syncQueue = [];
  }

  // Conflict Methods

  getConflicts(): ConflictInfo[] {
    return this.storage.conflicts;
  }

  addConflict(conflict: ConflictInfo): void {
    // Remove existing conflict for same file
    this.storage.conflicts = this.storage.conflicts.filter(
      c => c.path !== conflict.path
    );
    this.storage.conflicts.push(conflict);
  }

  removeConflict(conflictId: string): void {
    this.storage.conflicts = this.storage.conflicts.filter(
      c => c.id !== conflictId
    );
  }

  clearConflicts(): void {
    this.storage.conflicts = [];
  }

  // Presence Methods

  getActiveUsers(): Record<string, ActiveUser> {
    return this.storage.activeUsers;
  }

  setActiveUsers(users: Record<string, ActiveUser>): void {
    this.storage.activeUsers = users;
  }

  setActiveUser(userId: string, user: ActiveUser): void {
    this.storage.activeUsers[userId] = user;
  }

  removeActiveUser(userId: string): void {
    delete this.storage.activeUsers[userId];
  }

  clearActiveUsers(): void {
    this.storage.activeUsers = {};
  }

  getFileViewers(filePath?: string): Record<string, string[]> | string[] {
    if (filePath) {
      return this.storage.fileViewers[filePath] || [];
    }
    return this.storage.fileViewers;
  }

  setFileViewers(viewers: Record<string, string[]>): void {
    this.storage.fileViewers = viewers;
  }

  addFileViewer(filePath: string, userId: string): void {
    if (!this.storage.fileViewers[filePath]) {
      this.storage.fileViewers[filePath] = [];
    }
    if (!this.storage.fileViewers[filePath].includes(userId)) {
      this.storage.fileViewers[filePath].push(userId);
    }
  }

  removeFileViewer(filePath: string, userId: string): void {
    if (this.storage.fileViewers[filePath]) {
      this.storage.fileViewers[filePath] = this.storage.fileViewers[filePath].filter(
        id => id !== userId
      );
      if (this.storage.fileViewers[filePath].length === 0) {
        delete this.storage.fileViewers[filePath];
      }
    }
  }

  // Yjs Document Methods

  getYjsDocument(filePath: string): Uint8Array | null {
    return this.storage.yjsDocuments[filePath] || null;
  }

  setYjsDocument(filePath: string, state: Uint8Array): void {
    this.storage.yjsDocuments[filePath] = state;
  }

  deleteYjsDocument(filePath: string): void {
    delete this.storage.yjsDocuments[filePath];
  }

  // Cache Methods

  getVaultCache(): VaultInfo | null {
    return this.storage.vaultCache;
  }

  setVaultCache(vault: VaultInfo): void {
    this.storage.vaultCache = vault;
  }

  clearVaultCache(): void {
    this.storage.vaultCache = null;
  }

  getFileCache(fileId: string): FileInfo | null {
    return this.storage.filesCache[fileId] || null;
  }

  setFileCache(fileId: string, file: FileInfo): void {
    this.storage.filesCache[fileId] = file;
  }

  clearFileCache(): void {
    this.storage.filesCache = {};
  }

  // Generic Storage Methods

  /**
   * Get a value from storage by key
   */
  async get<T>(key: string): Promise<T | null> {
    const data = await this.plugin.loadData();
    return data?.[key] || null;
  }

  /**
   * Set a value in storage by key
   */
  async set<T>(key: string, value: T): Promise<void> {
    const data = await this.plugin.loadData() || {};
    data[key] = value;
    await this.plugin.saveData(data);
  }

  /**
   * Delete a value from storage by key
   */
  async delete(key: string): Promise<void> {
    const data = await this.plugin.loadData() || {};
    delete data[key];
    await this.plugin.saveData(data);
  }

  // Utility Methods

  async clear(): Promise<void> {
    this.storage = this.getDefaultStorage();
    await this.save();
  }

  getStorageSize(): number {
    return JSON.stringify(this.storage).length;
  }
}
