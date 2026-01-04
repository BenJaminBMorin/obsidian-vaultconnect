import { VaultService } from '../VaultService';
import { APIClient } from '../../api/APIClient';
import { StorageManager } from '../../core/StorageManager';
import { EventBus, EVENTS } from '../../core/EventBus';
import { Plugin } from 'obsidian';
import { VaultInfo } from '../../types';

describe('VaultService', () => {
  let vaultService: VaultService;
  let mockPlugin: Plugin;
  let mockApiClient: jest.Mocked<APIClient>;
  let mockStorage: jest.Mocked<StorageManager>;
  let eventBus: EventBus;
  let mockData: Record<string, unknown>;

  const mockVault: VaultInfo = {
    vault_id: 'vault-123',
    name: 'Test Vault',
    file_count: 10,
    total_size_bytes: 1024,
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-02')
  };

  beforeEach(() => {
    mockData = {};
    mockPlugin = {
      loadData: jest.fn().mockResolvedValue(mockData),
      saveData: jest.fn().mockImplementation((data) => {
        mockData = data;
        return Promise.resolve();
      })
    } as Partial<Plugin> as Plugin;

    mockApiClient = {
      listVaults: jest.fn(),
      getVault: jest.fn(),
      createVault: jest.fn()
    } as jest.Mocked<APIClient>;

    mockStorage = {
      getVaultCache: jest.fn(),
      setVaultCache: jest.fn(),
      clearVaultCache: jest.fn(),
      getLastSyncTimestamp: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined)
    } as jest.Mocked<StorageManager>;

    eventBus = new EventBus();
    vaultService = new VaultService(mockPlugin, mockApiClient, mockStorage, eventBus);
  });

  describe('Initialization', () => {
    it('should initialize without cached vault', async () => {
      mockStorage.getVaultCache.mockReturnValue(null);
      
      await vaultService.initialize();
      
      expect(vaultService.getCurrentVault()).toBeNull();
    });

    it('should load cached vault on initialization', async () => {
      mockStorage.getVaultCache.mockReturnValue(mockVault);
      
      await vaultService.initialize();
      
      expect(vaultService.getCurrentVault()).toEqual(mockVault);
    });

    it('should load selected vault from settings', async () => {
      mockData.selectedVaultId = 'vault-123';
      mockApiClient.getVault.mockResolvedValue(mockVault);
      
      await vaultService.initialize();
      
      expect(mockApiClient.getVault).toHaveBeenCalledWith('vault-123');
      expect(vaultService.getCurrentVault()).toEqual(mockVault);
    });
  });

  describe('Fetch Vaults', () => {
    it('should fetch vaults from API', async () => {
      const vaults = [mockVault];
      mockApiClient.listVaults.mockResolvedValue(vaults);
      
      const result = await vaultService.fetchVaults();
      
      expect(mockApiClient.listVaults).toHaveBeenCalled();
      expect(result).toEqual(vaults);
    });

    it('should use cached vaults when not expired', async () => {
      const vaults = [mockVault];
      mockApiClient.listVaults.mockResolvedValue(vaults);
      
      // First call - should fetch from API
      await vaultService.fetchVaults();
      expect(mockApiClient.listVaults).toHaveBeenCalledTimes(1);
      
      // Second call - should use cache
      await vaultService.fetchVaults();
      expect(mockApiClient.listVaults).toHaveBeenCalledTimes(1);
    });

    it('should force refresh when requested', async () => {
      const vaults = [mockVault];
      mockApiClient.listVaults.mockResolvedValue(vaults);
      
      await vaultService.fetchVaults();
      await vaultService.fetchVaults(true);
      
      expect(mockApiClient.listVaults).toHaveBeenCalledTimes(2);
    });

    it('should handle fetch error', async () => {
      mockApiClient.listVaults.mockRejectedValue(new Error('Network error'));
      
      await expect(vaultService.fetchVaults()).rejects.toThrow('Failed to fetch vaults');
    });
  });

  describe('Select Vault', () => {
    it('should select vault successfully', async () => {
      mockApiClient.getVault.mockResolvedValue(mockVault);
      
      await vaultService.selectVault('vault-123');
      
      expect(mockApiClient.getVault).toHaveBeenCalledWith('vault-123');
      expect(vaultService.getCurrentVault()).toEqual(mockVault);
      expect(mockStorage.setVaultCache).toHaveBeenCalledWith(mockVault);
      expect(mockData.selectedVaultId).toBe('vault-123');
    });

    it('should emit vault changed event', async () => {
      mockApiClient.getVault.mockResolvedValue(mockVault);
      const callback = jest.fn();
      vaultService.onVaultChanged(callback);
      
      await vaultService.selectVault('vault-123');
      
      expect(callback).toHaveBeenCalledWith(mockVault);
    });

    it('should handle select error', async () => {
      mockApiClient.getVault.mockRejectedValue(new Error('Vault not found'));
      
      await expect(vaultService.selectVault('invalid-id')).rejects.toThrow('Failed to select vault');
    });
  });

  describe('Current Vault', () => {
    it('should return null when no vault selected', () => {
      expect(vaultService.getCurrentVault()).toBeNull();
      expect(vaultService.getCurrentVaultId()).toBeNull();
      expect(vaultService.hasVaultSelected()).toBe(false);
    });

    it('should return current vault when selected', async () => {
      mockApiClient.getVault.mockResolvedValue(mockVault);
      await vaultService.selectVault('vault-123');
      
      expect(vaultService.getCurrentVault()).toEqual(mockVault);
      expect(vaultService.getCurrentVaultId()).toBe('vault-123');
      expect(vaultService.hasVaultSelected()).toBe(true);
    });
  });

  describe('Create Vault', () => {
    it('should create vault successfully', async () => {
      mockApiClient.createVault.mockResolvedValue(mockVault);
      
      const result = await vaultService.createVault('New Vault');
      
      expect(mockApiClient.createVault).toHaveBeenCalledWith('New Vault');
      expect(result).toEqual(mockVault);
    });

    it('should invalidate cache after creation', async () => {
      mockApiClient.createVault.mockResolvedValue(mockVault);
      mockApiClient.listVaults.mockResolvedValue([mockVault]);
      
      // Populate cache
      await vaultService.fetchVaults();
      expect(mockApiClient.listVaults).toHaveBeenCalledTimes(1);
      
      // Create vault
      await vaultService.createVault('New Vault');
      
      // Fetch again - should call API
      await vaultService.fetchVaults();
      expect(mockApiClient.listVaults).toHaveBeenCalledTimes(2);
    });
  });

  describe('Vault Stats', () => {
    it('should get vault stats for current vault', async () => {
      mockApiClient.getVault.mockResolvedValue(mockVault);
      mockStorage.getLastSyncTimestamp.mockReturnValue(new Date('2024-01-03'));
      
      await vaultService.selectVault('vault-123');
      const stats = await vaultService.getVaultStats();
      
      expect(stats.file_count).toBe(10);
      expect(stats.total_size_bytes).toBe(1024);
      expect(stats.last_sync).toEqual(new Date('2024-01-03'));
    });

    it('should get vault stats for specific vault', async () => {
      mockApiClient.getVault.mockResolvedValue(mockVault);
      mockStorage.getLastSyncTimestamp.mockReturnValue(null);
      
      const stats = await vaultService.getVaultStats('vault-123');
      
      expect(mockApiClient.getVault).toHaveBeenCalledWith('vault-123');
      expect(stats.file_count).toBe(10);
      expect(stats.last_sync).toBeNull();
    });

    it('should throw error when no vault selected', async () => {
      await expect(vaultService.getVaultStats()).rejects.toThrow('No vault selected');
    });
  });

  describe('Clear Vault Selection', () => {
    it('should clear vault selection', async () => {
      mockApiClient.getVault.mockResolvedValue(mockVault);
      await vaultService.selectVault('vault-123');
      
      await vaultService.clearVaultSelection();
      
      expect(vaultService.getCurrentVault()).toBeNull();
      expect(mockStorage.clearVaultCache).toHaveBeenCalled();
      expect(mockData.selectedVaultId).toBeNull();
    });

    it('should emit vault changed event with null', async () => {
      mockApiClient.getVault.mockResolvedValue(mockVault);
      await vaultService.selectVault('vault-123');
      
      const callback = jest.fn();
      vaultService.onVaultChanged(callback);
      
      await vaultService.clearVaultSelection();
      
      expect(callback).toHaveBeenCalledWith(null);
    });
  });

  describe('Search Vaults', () => {
    it('should search vaults by name', async () => {
      const vaults = [
        { ...mockVault, name: 'Personal Notes' },
        { ...mockVault, vault_id: 'vault-456', name: 'Work Documents' }
      ];
      mockApiClient.listVaults.mockResolvedValue(vaults);
      
      const results = await vaultService.searchVaults('personal');
      
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Personal Notes');
    });

    it('should return all vaults for empty query', async () => {
      const vaults = [mockVault];
      mockApiClient.listVaults.mockResolvedValue(vaults);
      
      const results = await vaultService.searchVaults('');
      
      expect(results).toEqual(vaults);
    });
  });

  describe('Get Most Recent Vault', () => {
    it('should return most recently created vault', async () => {
      const vaults = [
        { ...mockVault, created_at: new Date('2024-01-01') },
        { ...mockVault, vault_id: 'vault-456', created_at: new Date('2024-01-05') },
        { ...mockVault, vault_id: 'vault-789', created_at: new Date('2024-01-03') }
      ];
      mockApiClient.listVaults.mockResolvedValue(vaults);
      
      const result = await vaultService.getMostRecentVault();
      
      expect(result?.vault_id).toBe('vault-456');
    });

    it('should return null when no vaults exist', async () => {
      mockApiClient.listVaults.mockResolvedValue([]);
      
      const result = await vaultService.getMostRecentVault();
      
      expect(result).toBeNull();
    });
  });

  describe('Cache Management', () => {
    it('should clear cache', () => {
      vaultService.clearCache();
      
      const status = vaultService.getCacheStatus();
      expect(status.hasCachedVaults).toBe(false);
      expect(status.isExpired).toBe(true);
    });

    it('should report cache status', async () => {
      mockApiClient.listVaults.mockResolvedValue([mockVault]);
      
      await vaultService.fetchVaults();
      
      const status = vaultService.getCacheStatus();
      expect(status.hasCachedVaults).toBe(true);
      expect(status.cacheExpiry).not.toBeNull();
      expect(status.isExpired).toBe(false);
    });
  });
});
