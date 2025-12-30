import { Plugin } from 'obsidian';
import { APIClient } from '../api/APIClient';
import { StorageManager } from '../core/StorageManager';
import { EventBus, EVENTS } from '../core/EventBus';
import { VaultInfo } from '../types';
import { parseErrorMessage } from '../utils/helpers';

export interface VaultStats {
  file_count: number;
  total_size_bytes: number;
  last_sync: Date | null;
}

/**
 * Vault Service
 * Manages vault selection and metadata
 */
export class VaultService {
  private plugin: Plugin;
  private apiClient: APIClient;
  private storage: StorageManager;
  private eventBus: EventBus;
  private currentVault: VaultInfo | null = null;
  private vaultsCache: VaultInfo[] | null = null;
  private cacheExpiry: number = 0;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    plugin: Plugin,
    apiClient: APIClient,
    storage: StorageManager,
    eventBus: EventBus
  ) {
    this.plugin = plugin;
    this.apiClient = apiClient;
    this.storage = storage;
    this.eventBus = eventBus;
  }

  /**
   * Initialize vault service
   */
  async initialize(): Promise<void> {
    // Load cached vault info
    const cachedVault = this.storage.getVaultCache();
    if (cachedVault) {
      this.currentVault = cachedVault;
    }

    // Load selected vault from settings
    const settings = await this.plugin.loadData();
    if (settings?.selectedVaultId) {
      try {
        await this.selectVault(settings.selectedVaultId);
      } catch (error) {
        console.error('Failed to load selected vault:', error);
      }
    }
  }

  /**
   * Fetch all available vaults
   */
  async fetchVaults(forceRefresh: boolean = false): Promise<VaultInfo[]> {
    // Return cached vaults if available and not expired
    if (!forceRefresh && this.vaultsCache && Date.now() < this.cacheExpiry) {
      return this.vaultsCache;
    }

    try {
      const vaults = await this.apiClient.listVaults();
      
      // Fetch cross-tenant status for each vault
      const vaultsWithAccess = await Promise.all(
        vaults.map(async (vault) => {
          try {
            const accessInfo = await this.apiClient.getVaultAccess(vault.vault_id);
            return {
              ...vault,
              is_cross_tenant: accessInfo.is_cross_tenant,
              permission: accessInfo.permission,
              owner_tenant_id: accessInfo.owner_tenant_id
            };
          } catch (error) {
            // If access check fails, assume owned vault
            return {
              ...vault,
              is_cross_tenant: false,
              permission: 'admin' as const
            };
          }
        })
      );
      
      // Update cache
      this.vaultsCache = vaultsWithAccess;
      this.cacheExpiry = Date.now() + this.CACHE_TTL;
      
      return vaultsWithAccess;
    } catch (error) {
      console.error('Failed to fetch vaults:', error);
      throw new Error(`Failed to fetch vaults: ${parseErrorMessage(error)}`);
    }
  }

  /**
   * Select a vault
   */
  async selectVault(vaultId: string): Promise<void> {
    try {
      // Fetch vault details
      const vault = await this.apiClient.getVault(vaultId);
      
      // Fetch cross-tenant access information
      try {
        const accessInfo = await this.apiClient.getVaultAccess(vaultId);
        vault.is_cross_tenant = accessInfo.is_cross_tenant;
        vault.permission = accessInfo.permission;
        vault.owner_tenant_id = accessInfo.owner_tenant_id;
        
        console.debug('Vault access info:', {
          vault_id: vaultId,
          is_cross_tenant: vault.is_cross_tenant,
          permission: vault.permission
        });
      } catch (error) {
        // If access endpoint fails, assume not cross-tenant
        console.warn('Failed to fetch vault access info, assuming not cross-tenant:', error);
        vault.is_cross_tenant = false;
        vault.permission = 'admin';
      }
      
      // Update current vault
      this.currentVault = vault;
      
      // Cache vault info
      this.storage.setVaultCache(vault);
      await this.storage.save();
      
      // Save to settings
      const settings = await this.plugin.loadData() || {};
      settings.selectedVaultId = vaultId;
      await this.plugin.saveData(settings);
      
      // Emit vault changed event
      this.eventBus.emit(EVENTS.VAULT_CHANGED, vault);
      
      console.debug('Vault selected:', vault.name, vault.is_cross_tenant ? '(cross-tenant)' : '(owned)');
    } catch (error) {
      console.error('Failed to select vault:', error);
      throw new Error(`Failed to select vault: ${parseErrorMessage(error)}`);
    }
  }

  /**
   * Get current vault
   */
  getCurrentVault(): VaultInfo | null {
    return this.currentVault;
  }

  /**
   * Get current vault ID
   */
  getCurrentVaultId(): string | null {
    return this.currentVault?.vault_id || null;
  }

  /**
   * Check if a vault is selected
   */
  hasVaultSelected(): boolean {
    return this.currentVault !== null;
  }

  /**
   * Check if current vault is cross-tenant
   */
  isCrossTenantVault(): boolean {
    return this.currentVault?.is_cross_tenant === true;
  }

  /**
   * Get current vault permission level
   */
  getCurrentVaultPermission(): 'read' | 'write' | 'admin' | null {
    return this.currentVault?.permission || null;
  }

  /**
   * Check if current vault has write permission
   */
  hasWritePermission(): boolean {
    const permission = this.getCurrentVaultPermission();
    return permission === 'write' || permission === 'admin';
  }

  /**
   * Create a new vault
   */
  async createVault(name: string): Promise<VaultInfo> {
    try {
      const vault = await this.apiClient.createVault(name);
      
      // Invalidate cache
      this.vaultsCache = null;
      
      console.debug('Vault created:', vault.name);
      return vault;
    } catch (error) {
      console.error('Failed to create vault:', error);
      throw new Error(`Failed to create vault: ${parseErrorMessage(error)}`);
    }
  }

  /**
   * Get vault statistics
   */
  async getVaultStats(vaultId?: string): Promise<VaultStats> {
    const targetVaultId = vaultId || this.getCurrentVaultId();
    
    if (!targetVaultId) {
      throw new Error('No vault selected');
    }

    try {
      const vault = await this.apiClient.getVault(targetVaultId);
      
      return {
        file_count: vault.file_count,
        total_size_bytes: vault.total_size_bytes,
        last_sync: this.storage.getLastSyncTimestamp('__vault__')
      };
    } catch (error) {
      console.error('Failed to get vault stats:', error);
      throw new Error(`Failed to get vault stats: ${parseErrorMessage(error)}`);
    }
  }

  /**
   * Refresh current vault info
   */
  async refreshCurrentVault(): Promise<void> {
    const vaultId = this.getCurrentVaultId();
    if (!vaultId) {
      throw new Error('No vault selected');
    }

    try {
      const vault = await this.apiClient.getVault(vaultId);
      this.currentVault = vault;
      
      // Update cache
      this.storage.setVaultCache(vault);
      await this.storage.save();
      
      // Emit stats updated event
      this.eventBus.emit(EVENTS.VAULT_STATS_UPDATED, {
        file_count: vault.file_count,
        total_size_bytes: vault.total_size_bytes
      });
    } catch (error) {
      console.error('Failed to refresh vault:', error);
      throw new Error(`Failed to refresh vault: ${parseErrorMessage(error)}`);
    }
  }

  /**
   * Clear vault selection
   */
  async clearVaultSelection(): Promise<void> {
    this.currentVault = null;
    
    // Clear cache
    this.storage.clearVaultCache();
    await this.storage.save();
    
    // Clear from settings
    const settings = await this.plugin.loadData() || {};
    settings.selectedVaultId = null;
    await this.plugin.saveData(settings);
    
    // Emit vault changed event
    this.eventBus.emit(EVENTS.VAULT_CHANGED, null);
    
    console.debug('Vault selection cleared');
  }

  /**
   * Get vault by ID from cache or API
   */
  async getVault(vaultId: string): Promise<VaultInfo> {
    // Check if it's the current vault
    if (this.currentVault && this.currentVault.vault_id === vaultId) {
      return this.currentVault;
    }

    // Check cache
    if (this.vaultsCache) {
      const cached = this.vaultsCache.find(v => v.vault_id === vaultId);
      if (cached) {
        return cached;
      }
    }

    // Fetch from API
    try {
      return await this.apiClient.getVault(vaultId);
    } catch (error) {
      console.error('Failed to get vault:', error);
      throw new Error(`Failed to get vault: ${parseErrorMessage(error)}`);
    }
  }

  /**
   * Search vaults by name
   */
  async searchVaults(query: string): Promise<VaultInfo[]> {
    const vaults = await this.fetchVaults();
    
    if (!query.trim()) {
      return vaults;
    }

    const lowerQuery = query.toLowerCase();
    return vaults.filter(vault =>
      vault.name.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Get most recently created vault
   */
  async getMostRecentVault(): Promise<VaultInfo | null> {
    const vaults = await this.fetchVaults();
    
    if (vaults.length === 0) {
      return null;
    }

    return vaults.reduce((latest, vault) =>
      vault.created_at > latest.created_at ? vault : latest
    );
  }

  /**
   * Subscribe to vault changes
   */
  onVaultChanged(callback: (vault: VaultInfo | null) => void): () => void {
    return this.eventBus.on(EVENTS.VAULT_CHANGED, callback);
  }

  /**
   * Subscribe to vault stats updates
   */
  onVaultStatsUpdated(callback: (stats: VaultStats) => void): () => void {
    return this.eventBus.on(EVENTS.VAULT_STATS_UPDATED, callback);
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.vaultsCache = null;
    this.cacheExpiry = 0;
  }

  /**
   * Get cache status
   */
  getCacheStatus(): {
    hasCachedVaults: boolean;
    cacheExpiry: Date | null;
    isExpired: boolean;
  } {
    return {
      hasCachedVaults: this.vaultsCache !== null,
      cacheExpiry: this.cacheExpiry > 0 ? new Date(this.cacheExpiry) : null,
      isExpired: Date.now() >= this.cacheExpiry
    };
  }
}
