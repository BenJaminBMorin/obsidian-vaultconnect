import { TFile, TAbstractFile, Vault } from 'obsidian';
import { EventBus, EVENTS } from '../core/EventBus';
import { SelectiveSyncService } from './SelectiveSyncService';

/**
 * File change event
 */
export interface FileChangeEvent {
  file: TFile;
  path: string;
  action: 'create' | 'modify' | 'delete' | 'rename';
  oldPath?: string;
  timestamp: number;
}

/**
 * File watcher configuration
 */
export interface FileWatcherConfig {
  debounceDelay: number;
}

/**
 * Service for watching file system changes in Obsidian vault
 */
export class FileWatcherService {
  private vault: Vault;
  private eventBus: EventBus;
  private selectiveSyncService: SelectiveSyncService;
  private config: FileWatcherConfig;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private isWatching: boolean = false;
  private ignoredPaths: Set<string> = new Set(); // Paths currently being written by downloads

  constructor(
    vault: Vault, 
    eventBus: EventBus, 
    selectiveSyncService: SelectiveSyncService,
    config: FileWatcherConfig
  ) {
    this.vault = vault;
    this.eventBus = eventBus;
    this.selectiveSyncService = selectiveSyncService;
    this.config = config;
  }

  /**
   * Start watching file changes
   */
  start(): void {
    if (this.isWatching) {
      console.warn('FileWatcherService is already watching');
      return;
    }

    this.isWatching = true;
    console.debug('FileWatcherService started');
  }

  /**
   * Stop watching file changes
   */
  stop(): void {
    if (!this.isWatching) {
      return;
    }

    // Clear all pending debounce timers
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();

    this.isWatching = false;
    console.debug('FileWatcherService stopped');
  }

  /**
   * Temporarily ignore a file path (used when downloading from remote to prevent sync loop)
   */
  ignorePath(path: string): void {
    this.ignoredPaths.add(path);
    console.debug(`[FileWatcher] Ignoring path: ${path}`);
  }

  /**
   * Stop ignoring a file path
   */
  unignorePath(path: string): void {
    this.ignoredPaths.delete(path);
    console.debug(`[FileWatcher] Unignoring path: ${path}`);
  }

  /**
   * Check if a path is currently being ignored
   */
  isPathIgnored(path: string): boolean {
    return this.ignoredPaths.has(path);
  }

  /**
   * Check if a file should be synced based on selective sync rules
   */
  shouldSyncFile(file: TFile): boolean {
    return this.selectiveSyncService.shouldSyncFile(file);
  }

  /**
   * Handle file creation
   */
  handleCreate(file: TAbstractFile): void {
    if (!this.isWatching) return;

    if (file instanceof TFile) {
      // Skip if this file is being written by a download
      if (this.isPathIgnored(file.path)) {
        console.debug(`[FileWatcher] Skipping create event for ignored path: ${file.path}`);
        return;
      }

      if (this.shouldSyncFile(file)) {
        this.debounceFileChange(file, 'create');
      }
    }
  }

  /**
   * Handle file modification
   */
  handleModify(file: TAbstractFile): void {
    if (!this.isWatching) return;

    if (file instanceof TFile) {
      // Skip if this file is being written by a download
      if (this.isPathIgnored(file.path)) {
        console.debug(`[FileWatcher] Skipping modify event for ignored path: ${file.path}`);
        return;
      }

      if (this.shouldSyncFile(file)) {
        this.debounceFileChange(file, 'modify');
      }
    }
  }

  /**
   * Handle file deletion
   */
  handleDelete(file: TAbstractFile): void {
    if (!this.isWatching) return;
    
    if (file instanceof TFile && this.shouldSyncFile(file)) {
      // For delete, we don't debounce as the file is already gone
      this.emitFileChange(file, 'delete');
    }
  }

  /**
   * Handle file rename
   */
  handleRename(file: TAbstractFile, oldPath: string): void {
    if (!this.isWatching) return;
    
    if (file instanceof TFile && this.shouldSyncFile(file)) {
      this.debounceFileChange(file, 'rename', oldPath);
    }
  }

  /**
   * Debounce file changes to avoid excessive sync operations
   */
  private debounceFileChange(
    file: TFile,
    action: 'create' | 'modify' | 'rename',
    oldPath?: string
  ): void {
    const key = file.path;

    // Clear existing timer for this file
    const existingTimer = this.debounceTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.emitFileChange(file, action, oldPath);
    }, this.config.debounceDelay);

    this.debounceTimers.set(key, timer);
  }

  /**
   * Emit file change event
   */
  private emitFileChange(
    file: TFile,
    action: 'create' | 'modify' | 'delete' | 'rename',
    oldPath?: string
  ): void {
    const event: FileChangeEvent = {
      file,
      path: file.path,
      action,
      oldPath,
      timestamp: Date.now()
    };

    console.debug(`File ${action}:`, event.path);
    this.eventBus.emit(EVENTS.FILE_SYNCED, event);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<FileWatcherConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): FileWatcherConfig {
    return { ...this.config };
  }

  /**
   * Check if watching is active
   */
  isActive(): boolean {
    return this.isWatching;
  }

  /**
   * Get number of pending debounced changes
   */
  getPendingChangesCount(): number {
    return this.debounceTimers.size;
  }
}
