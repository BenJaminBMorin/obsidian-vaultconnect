import { Plugin } from 'obsidian';
import { PluginSettings } from '../types';
import { DEFAULT_SETTINGS } from '../utils/constants';

/**
 * Settings Manager
 * Handles settings persistence, migration, and validation
 */
export class SettingsManager {
  private plugin: Plugin;
  private settings: PluginSettings;
  private readonly SETTINGS_VERSION = 1;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.settings = { ...DEFAULT_SETTINGS };
  }

  /**
   * Load settings from storage
   */
  async loadSettings(): Promise<PluginSettings> {
    try {
      const data = await this.plugin.loadData();
      
      if (!data) {
        // First time load, use defaults
        this.settings = { ...DEFAULT_SETTINGS };
        await this.saveSettings();
        return this.settings;
      }

      // Migrate settings if needed
      const migratedData = await this.migrateSettings(data);
      
      // Merge with defaults to ensure all fields exist
      this.settings = Object.assign({}, DEFAULT_SETTINGS, migratedData);
      
      // Validate settings
      this.validateSettings();
      
      // Save if migration occurred
      if (migratedData !== data) {
        await this.saveSettings();
      }
      
      return this.settings;
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.settings = { ...DEFAULT_SETTINGS };
      return this.settings;
    }
  }

  /**
   * Save settings to storage
   */
  async saveSettings(): Promise<void> {
    try {
      // Add version info
      const dataToSave = {
        ...this.settings,
        _version: this.SETTINGS_VERSION,
        _lastSaved: new Date().toISOString()
      };
      
      await this.plugin.saveData(dataToSave);
    } catch (error) {
      console.error('Failed to save settings:', error);
      throw error;
    }
  }

  /**
   * Get current settings
   */
  getSettings(): PluginSettings {
    return this.settings;
  }

  /**
   * Update settings
   */
  updateSettings(updates: Partial<PluginSettings>): void {
    Object.assign(this.settings, updates);
  }

  /**
   * Reset settings to defaults (preserving auth and device info)
   */
  async resetSettings(): Promise<void> {
    const apiKey = this.settings.apiKey;
    const apiKeyExpires = this.settings.apiKeyExpires;
    const selectedVaultId = this.settings.selectedVaultId;
    const deviceId = this.settings.deviceId;
    
    this.settings = { ...DEFAULT_SETTINGS };
    
    // Restore preserved values
    this.settings.apiKey = apiKey;
    this.settings.apiKeyExpires = apiKeyExpires;
    this.settings.selectedVaultId = selectedVaultId;
    this.settings.deviceId = deviceId;
    
    await this.saveSettings();
  }

  /**
   * Migrate settings from older versions
   */
  private async migrateSettings(data: unknown): Promise<Record<string, unknown>> {
    const dataObj = data as Record<string, unknown>;
    const version = (dataObj._version as number) || 0;

    if (version === this.SETTINGS_VERSION) {
      return dataObj;
    }

    console.debug(`Migrating settings from version ${version} to ${this.SETTINGS_VERSION}`);

    let migratedData = { ...dataObj };

    // Migration from version 0 (initial) to version 1
    if (version < 1) {
      migratedData = this.migrateV0ToV1(migratedData);
    }

    // Add future migrations here
    // if (version < 2) {
    //   migratedData = this.migrateV1ToV2(migratedData);
    // }

    return migratedData;
  }

  /**
   * Migrate from version 0 to version 1
   * Handles old main.ts settings structure
   */
  private migrateV0ToV1(data: Record<string, unknown>): Record<string, unknown> {
    const migrated: Record<string, unknown> = {};

    // Map old field names to new ones
    if (data.apiUrl) {
      migrated.apiBaseURL = data.apiUrl;
    }
    if (data.wsUrl) {
      migrated.wsBaseURL = data.wsUrl;
    }
    if (data.vaultId) {
      migrated.selectedVaultId = data.vaultId;
    }

    // Copy over fields that have the same name
    const directCopyFields = [
      'apiKey',
      'apiKeyExpires',
      'deviceId',
      'autoSync',
      'syncInterval',
      'includedFolders',
      'excludedFolders',
      'syncMode',
      'collaborationEnabled',
      'showPresence',
      'showCursors',
      'showTypingIndicators',
      'notifyOnSync',
      'notifyOnConflict',
      'notifyOnCollaboratorJoin',
      'maxConcurrentUploads',
      'chunkSize',
      'cacheEnabled',
      'debugMode'
    ];

    for (const field of directCopyFields) {
      if (data[field] !== undefined) {
        migrated[field] = data[field];
      }
    }

    return migrated;
  }

  /**
   * Validate settings and fix any invalid values
   */
  private validateSettings(): void {
    // Validate sync interval
    if (this.settings.syncInterval < 10) {
      this.settings.syncInterval = 10;
    }
    if (this.settings.syncInterval > 300) {
      this.settings.syncInterval = 300;
    }

    // Validate max concurrent uploads
    if (this.settings.maxConcurrentUploads < 1) {
      this.settings.maxConcurrentUploads = 1;
    }
    if (this.settings.maxConcurrentUploads > 10) {
      this.settings.maxConcurrentUploads = 10;
    }

    // Validate chunk size (1MB to 10MB)
    if (this.settings.chunkSize < 1048576) {
      this.settings.chunkSize = 1048576;
    }
    if (this.settings.chunkSize > 10485760) {
      this.settings.chunkSize = 10485760;
    }

    // Ensure arrays are arrays
    if (!Array.isArray(this.settings.includedFolders)) {
      this.settings.includedFolders = [];
    }
    // Use actual configDir instead of hardcoded path
    const configDir = this.plugin.app.vault.configDir;
    if (!Array.isArray(this.settings.excludedFolders)) {
      this.settings.excludedFolders = [configDir, '.trash'];
    } else if (!this.settings.excludedFolders.includes(configDir)) {
      // Ensure configDir is in the excluded folders list
      this.settings.excludedFolders.push(configDir);
    }

    // Validate URLs
    if (this.settings.apiBaseURL && !this.isValidUrl(this.settings.apiBaseURL)) {
      this.settings.apiBaseURL = DEFAULT_SETTINGS.apiBaseURL;
    }
    if (this.settings.wsBaseURL && !this.isValidUrl(this.settings.wsBaseURL)) {
      this.settings.wsBaseURL = DEFAULT_SETTINGS.wsBaseURL;
    }

    // Generate device ID if missing
    if (!this.settings.deviceId) {
      this.settings.deviceId = this.generateDeviceId();
    }
  }

  /**
   * Validate URL format
   */
  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generate a unique device ID
   */
  private generateDeviceId(): string {
    return `obsidian-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Export settings (sanitized, without sensitive data)
   */
  exportSettings(): string {
    const exportData: Partial<PluginSettings> = {
      syncMode: this.settings.syncMode,
      autoSync: this.settings.autoSync,
      syncInterval: this.settings.syncInterval,
      includedFolders: this.settings.includedFolders,
      excludedFolders: this.settings.excludedFolders,
      collaborationEnabled: this.settings.collaborationEnabled,
      showPresence: this.settings.showPresence,
      showCursors: this.settings.showCursors,
      showTypingIndicators: this.settings.showTypingIndicators,
      notifyOnSync: this.settings.notifyOnSync,
      notifyOnConflict: this.settings.notifyOnConflict,
      notifyOnCollaboratorJoin: this.settings.notifyOnCollaboratorJoin,
      maxConcurrentUploads: this.settings.maxConcurrentUploads,
      chunkSize: this.settings.chunkSize,
      cacheEnabled: this.settings.cacheEnabled,
      apiBaseURL: this.settings.apiBaseURL,
      wsBaseURL: this.settings.wsBaseURL,
      debugMode: this.settings.debugMode
    };

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Import settings from JSON string
   */
  async importSettings(json: string): Promise<boolean> {
    try {
      const importedSettings = JSON.parse(json);
      
      // Validate imported settings
      if (!this.validateImportedSettings(importedSettings)) {
        return false;
      }
      
      // Merge with current settings (preserve auth and device info)
      Object.assign(this.settings, importedSettings);
      
      // Validate after import
      this.validateSettings();
      
      await this.saveSettings();
      return true;
    } catch (error) {
      console.error('Failed to import settings:', error);
      return false;
    }
  }

  /**
   * Validate imported settings structure
   */
  private validateImportedSettings(settings: unknown): boolean {
    if (typeof settings !== 'object' || settings === null) {
      return false;
    }

    const settingsObj = settings as Record<string, unknown>;

    // Validate sync mode if present
    if (settingsObj.syncMode && !['smart_sync', 'pull_all', 'push_all', 'manual'].includes(settingsObj.syncMode as string)) {
      return false;
    }

    // Validate arrays if present
    if (settingsObj.includedFolders && !Array.isArray(settingsObj.includedFolders)) {
      return false;
    }
    if (settingsObj.excludedFolders && !Array.isArray(settingsObj.excludedFolders)) {
      return false;
    }

    // Validate numbers if present
    if (settingsObj.syncInterval !== undefined && (typeof settingsObj.syncInterval !== 'number' || settingsObj.syncInterval <= 0)) {
      return false;
    }
    if (settingsObj.maxConcurrentUploads !== undefined && (typeof settingsObj.maxConcurrentUploads !== 'number' || settingsObj.maxConcurrentUploads < 1)) {
      return false;
    }

    return true;
  }
}
