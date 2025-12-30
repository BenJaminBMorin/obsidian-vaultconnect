import { TFile } from 'obsidian';
import { EventBus, EVENTS } from '../core/EventBus';
import { StorageManager } from '../core/StorageManager';

/**
 * Selective sync configuration
 */
export interface SelectiveSyncConfig {
  includedFolders: string[];
  excludedFolders: string[];
}

/**
 * Folder pattern for matching
 */
export interface FolderPattern {
  pattern: string;
  isGlob: boolean;
}

/**
 * Sync scope statistics
 */
export interface SyncScopeStats {
  totalFiles: number;
  includedFiles: number;
  excludedFiles: number;
  includedFolders: string[];
  excludedFolders: string[];
}

/**
 * Service for managing selective sync - which files and folders to sync
 */
export class SelectiveSyncService {
  private eventBus: EventBus;
  private storage: StorageManager;
  private config: SelectiveSyncConfig;
  private configDir: string;

  constructor(
    eventBus: EventBus,
    storage: StorageManager,
    config: SelectiveSyncConfig,
    configDir: string = '.obsidian'
  ) {
    this.eventBus = eventBus;
    this.storage = storage;
    this.configDir = configDir;
    this.config = this.normalizeConfig(config);
  }

  /**
   * Get default excluded folders (uses configDir dynamically)
   */
  private getDefaultExcludedFolders(): string[] {
    return [this.configDir, '.trash'];
  }

  /**
   * Normalize configuration to ensure defaults are applied
   */
  private normalizeConfig(config: SelectiveSyncConfig): SelectiveSyncConfig {
    const normalized: SelectiveSyncConfig = {
      includedFolders: [...config.includedFolders],
      excludedFolders: [...config.excludedFolders]
    };

    // Ensure default exclusions are present
    for (const defaultExcluded of this.getDefaultExcludedFolders()) {
      if (!normalized.excludedFolders.includes(defaultExcluded)) {
        normalized.excludedFolders.push(defaultExcluded);
      }
    }

    return normalized;
  }

  /**
   * Check if a file should be synced based on selective sync rules
   */
  shouldSyncFile(file: TFile): boolean {
    return this.shouldSyncPath(file.path);
  }

  /**
   * Check if a path should be synced based on selective sync rules
   */
  shouldSyncPath(path: string): boolean {
    // First check if path is excluded
    if (this.isPathExcluded(path)) {
      return false;
    }

    // If there are included folders specified, check if path is in one of them
    if (this.config.includedFolders.length > 0) {
      return this.isPathIncluded(path);
    }

    // No included folders specified, so sync everything that's not excluded
    return true;
  }

  /**
   * Check if a path is explicitly excluded
   */
  private isPathExcluded(path: string): boolean {
    for (const excludedFolder of this.config.excludedFolders) {
      if (this.matchesPattern(path, excludedFolder)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a path is in an included folder
   */
  private isPathIncluded(path: string): boolean {
    for (const includedFolder of this.config.includedFolders) {
      if (this.matchesPattern(path, includedFolder)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a path matches a folder pattern
   */
  private matchesPattern(path: string, pattern: string): boolean {
    // Normalize pattern (remove trailing slash)
    const normalizedPattern = pattern.endsWith('/') 
      ? pattern.slice(0, -1) 
      : pattern;

    // Check if path is exactly the pattern
    if (path === normalizedPattern) {
      return true;
    }

    // Check if path is inside the pattern folder
    if (path.startsWith(normalizedPattern + '/')) {
      return true;
    }

    // Check for glob patterns (simple * wildcard support)
    if (normalizedPattern.includes('*')) {
      const regex = this.patternToRegex(normalizedPattern);
      return regex.test(path);
    }

    return false;
  }

  /**
   * Convert a simple glob pattern to regex
   */
  private patternToRegex(pattern: string): RegExp {
    // Escape special regex characters except *
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    
    // Replace * with .*
    const regexPattern = escaped.replace(/\*/g, '.*');
    
    // Match from start and allow anything after
    return new RegExp(`^${regexPattern}(/.*)?$`);
  }

  /**
   * Add a folder to the excluded list
   */
  addExcludedFolder(folder: string): void {
    const normalized = this.normalizeFolderPath(folder);
    if (!this.config.excludedFolders.includes(normalized)) {
      this.config.excludedFolders.push(normalized);
      this.emitConfigChanged();
    }
  }

  /**
   * Remove a folder from the excluded list
   */
  removeExcludedFolder(folder: string): void {
    const normalized = this.normalizeFolderPath(folder);
    const index = this.config.excludedFolders.indexOf(normalized);
    if (index !== -1) {
      this.config.excludedFolders.splice(index, 1);
      this.emitConfigChanged();
    }
  }

  /**
   * Add a folder to the included list
   */
  addIncludedFolder(folder: string): void {
    const normalized = this.normalizeFolderPath(folder);
    if (!this.config.includedFolders.includes(normalized)) {
      this.config.includedFolders.push(normalized);
      this.emitConfigChanged();
    }
  }

  /**
   * Remove a folder from the included list
   */
  removeIncludedFolder(folder: string): void {
    const normalized = this.normalizeFolderPath(folder);
    const index = this.config.includedFolders.indexOf(normalized);
    if (index !== -1) {
      this.config.includedFolders.splice(index, 1);
      this.emitConfigChanged();
    }
  }

  /**
   * Set excluded folders (replaces existing list)
   */
  setExcludedFolders(folders: string[]): void {
    this.config.excludedFolders = folders.map(f => this.normalizeFolderPath(f));

    // Ensure defaults are present
    for (const defaultExcluded of this.getDefaultExcludedFolders()) {
      if (!this.config.excludedFolders.includes(defaultExcluded)) {
        this.config.excludedFolders.push(defaultExcluded);
      }
    }

    this.emitConfigChanged();
  }

  /**
   * Set included folders (replaces existing list)
   */
  setIncludedFolders(folders: string[]): void {
    this.config.includedFolders = folders.map(f => this.normalizeFolderPath(f));
    this.emitConfigChanged();
  }

  /**
   * Clear all included folders (sync all except excluded)
   */
  clearIncludedFolders(): void {
    this.config.includedFolders = [];
    this.emitConfigChanged();
  }

  /**
   * Reset excluded folders to defaults
   */
  resetExcludedFolders(): void {
    this.config.excludedFolders = [...this.getDefaultExcludedFolders()];
    this.emitConfigChanged();
  }

  /**
   * Normalize folder path (remove leading/trailing slashes, trim)
   */
  private normalizeFolderPath(folder: string): string {
    let normalized = folder.trim();
    
    // Remove leading slash
    if (normalized.startsWith('/')) {
      normalized = normalized.slice(1);
    }
    
    // Remove trailing slash (unless it's a glob pattern)
    if (normalized.endsWith('/') && !normalized.includes('*')) {
      normalized = normalized.slice(0, -1);
    }
    
    return normalized;
  }

  /**
   * Get current configuration
   */
  getConfig(): SelectiveSyncConfig {
    return {
      includedFolders: [...this.config.includedFolders],
      excludedFolders: [...this.config.excludedFolders]
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SelectiveSyncConfig>): void {
    if (config.includedFolders !== undefined) {
      this.setIncludedFolders(config.includedFolders);
    }
    
    if (config.excludedFolders !== undefined) {
      this.setExcludedFolders(config.excludedFolders);
    }
  }

  /**
   * Get default excluded folders (static version for external use)
   * Note: Uses '.obsidian' as default since we don't have access to configDir statically
   */
  static getStaticDefaultExcludedFolders(): string[] {
    return ['.obsidian', '.trash'];
  }

  /**
   * Check if using default exclusions only
   */
  isUsingDefaultExclusionsOnly(): boolean {
    const defaults = this.getDefaultExcludedFolders();
    if (this.config.excludedFolders.length !== defaults.length) {
      return false;
    }

    for (const defaultExcluded of defaults) {
      if (!this.config.excludedFolders.includes(defaultExcluded)) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Check if selective sync is active (has custom inclusions/exclusions)
   */
  isSelectiveSyncActive(): boolean {
    return this.config.includedFolders.length > 0 || 
           !this.isUsingDefaultExclusionsOnly();
  }

  /**
   * Get list of common folders to suggest for quick toggles
   */
  getCommonFolders(): string[] {
    return [
      'notes',
      'docs',
      'journal',
      'daily',
      'templates',
      'attachments',
      'assets',
      'archive',
      'private',
      'drafts'
    ];
  }

  /**
   * Emit configuration changed event
   */
  private emitConfigChanged(): void {
    this.eventBus.emit(EVENTS.SELECTIVE_SYNC_CHANGED, this.getConfig());
  }

  /**
   * Validate folder pattern
   */
  validatePattern(pattern: string): { valid: boolean; error?: string } {
    if (!pattern || pattern.trim().length === 0) {
      return { valid: false, error: 'Pattern cannot be empty' };
    }

    const normalized = this.normalizeFolderPath(pattern);

    // Check for invalid characters
    const invalidChars = /[<>:"|?]/;
    if (invalidChars.test(normalized)) {
      return { valid: false, error: 'Pattern contains invalid characters' };
    }

    // Check for double slashes
    if (normalized.includes('//')) {
      return { valid: false, error: 'Pattern contains double slashes' };
    }

    return { valid: true };
  }

  /**
   * Get sync scope preview for a list of files
   */
  getSyncScopePreview(files: TFile[]): SyncScopeStats {
    const stats: SyncScopeStats = {
      totalFiles: files.length,
      includedFiles: 0,
      excludedFiles: 0,
      includedFolders: [...this.config.includedFolders],
      excludedFolders: [...this.config.excludedFolders]
    };

    for (const file of files) {
      if (this.shouldSyncFile(file)) {
        stats.includedFiles++;
      } else {
        stats.excludedFiles++;
      }
    }

    return stats;
  }

  /**
   * Get list of files that would be synced
   */
  getFilesToSync(files: TFile[]): TFile[] {
    return files.filter(file => this.shouldSyncFile(file));
  }

  /**
   * Get list of files that would be excluded
   */
  getFilesToExclude(files: TFile[]): TFile[] {
    return files.filter(file => !this.shouldSyncFile(file));
  }
}
