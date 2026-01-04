import { VaultInfo, FileInfo } from '../types';

/**
 * Cache entry with expiration
 */
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  createdAt: number;
}

/**
 * Cache configuration
 */
export interface CacheConfig {
  vaultMetadataTTL: number; // milliseconds
  fileListTTL: number; // milliseconds
  fileHashTTL: number; // milliseconds
  maxCacheSize: number; // bytes
}

/**
 * Default cache configuration
 */
const DEFAULT_CACHE_CONFIG: CacheConfig = {
  vaultMetadataTTL: 5 * 60 * 1000, // 5 minutes
  fileListTTL: 2 * 60 * 1000, // 2 minutes
  fileHashTTL: Infinity, // Never expire (invalidate on change)
  maxCacheSize: 10 * 1024 * 1024 // 10 MB
};

/**
 * Cache Service
 * Provides caching for vault metadata, file lists, and file hashes
 * Implements cache invalidation and size management
 */
export class CacheService {
  private config: CacheConfig;
  
  // Vault metadata cache
  private vaultMetadataCache: Map<string, CacheEntry<VaultInfo>> = new Map();
  private vaultsListCache: CacheEntry<VaultInfo[]> | null = null;
  
  // File list cache
  private fileListCache: Map<string, CacheEntry<FileInfo[]>> = new Map();
  
  // File hash cache
  private fileHashCache: Map<string, CacheEntry<string>> = new Map();
  
  // File metadata cache
  private fileMetadataCache: Map<string, CacheEntry<FileInfo>> = new Map();

  constructor(config?: Partial<CacheConfig>) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
  }

  // Vault Metadata Caching

  /**
   * Get cached vault metadata
   */
  getVaultMetadata(vaultId: string): VaultInfo | null {
    const entry = this.vaultMetadataCache.get(vaultId);
    if (!entry) return null;
    
    if (this.isExpired(entry)) {
      this.vaultMetadataCache.delete(vaultId);
      return null;
    }
    
    return entry.data;
  }

  /**
   * Set vault metadata in cache
   */
  setVaultMetadata(vaultId: string, vault: VaultInfo): void {
    const entry: CacheEntry<VaultInfo> = {
      data: vault,
      expiresAt: Date.now() + this.config.vaultMetadataTTL,
      createdAt: Date.now()
    };
    
    this.vaultMetadataCache.set(vaultId, entry);
    this.enforceMaxSize();
  }

  /**
   * Invalidate vault metadata cache
   */
  invalidateVaultMetadata(vaultId: string): void {
    this.vaultMetadataCache.delete(vaultId);
  }

  /**
   * Get cached vaults list
   */
  getVaultsList(): VaultInfo[] | null {
    if (!this.vaultsListCache) return null;
    
    if (this.isExpired(this.vaultsListCache)) {
      this.vaultsListCache = null;
      return null;
    }
    
    return this.vaultsListCache.data;
  }

  /**
   * Set vaults list in cache
   */
  setVaultsList(vaults: VaultInfo[]): void {
    this.vaultsListCache = {
      data: vaults,
      expiresAt: Date.now() + this.config.vaultMetadataTTL,
      createdAt: Date.now()
    };
    
    // Also cache individual vault metadata
    vaults.forEach(vault => {
      this.setVaultMetadata(vault.vault_id, vault);
    });
  }

  /**
   * Invalidate vaults list cache
   */
  invalidateVaultsList(): void {
    this.vaultsListCache = null;
  }

  // File List Caching

  /**
   * Get cached file list for a vault
   */
  getFileList(vaultId: string): FileInfo[] | null {
    const entry = this.fileListCache.get(vaultId);
    if (!entry) return null;
    
    if (this.isExpired(entry)) {
      this.fileListCache.delete(vaultId);
      return null;
    }
    
    return entry.data;
  }

  /**
   * Set file list in cache
   */
  setFileList(vaultId: string, files: FileInfo[]): void {
    const entry: CacheEntry<FileInfo[]> = {
      data: files,
      expiresAt: Date.now() + this.config.fileListTTL,
      createdAt: Date.now()
    };
    
    this.fileListCache.set(vaultId, entry);
    
    // Also cache individual file metadata
    files.forEach(file => {
      this.setFileMetadata(file.file_id, file);
    });
    
    this.enforceMaxSize();
  }

  /**
   * Invalidate file list cache for a vault
   */
  invalidateFileList(vaultId: string): void {
    this.fileListCache.delete(vaultId);
  }

  // File Hash Caching

  /**
   * Get cached file hash
   */
  getFileHash(filePath: string): string | null {
    const entry = this.fileHashCache.get(filePath);
    if (!entry) return null;
    
    if (this.isExpired(entry)) {
      this.fileHashCache.delete(filePath);
      return null;
    }
    
    return entry.data;
  }

  /**
   * Set file hash in cache
   */
  setFileHash(filePath: string, hash: string): void {
    const entry: CacheEntry<string> = {
      data: hash,
      expiresAt: Date.now() + this.config.fileHashTTL,
      createdAt: Date.now()
    };
    
    this.fileHashCache.set(filePath, entry);
    this.enforceMaxSize();
  }

  /**
   * Invalidate file hash cache
   */
  invalidateFileHash(filePath: string): void {
    this.fileHashCache.delete(filePath);
  }

  /**
   * Invalidate all file hashes for a vault
   */
  invalidateVaultFileHashes(vaultId: string): void {
    // Remove all hashes that start with the vault path
    const keysToDelete: string[] = [];
    this.fileHashCache.forEach((_, key) => {
      if (key.startsWith(`${vaultId}/`)) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach(key => this.fileHashCache.delete(key));
  }

  // File Metadata Caching

  /**
   * Get cached file metadata
   */
  getFileMetadata(fileId: string): FileInfo | null {
    const entry = this.fileMetadataCache.get(fileId);
    if (!entry) return null;
    
    if (this.isExpired(entry)) {
      this.fileMetadataCache.delete(fileId);
      return null;
    }
    
    return entry.data;
  }

  /**
   * Set file metadata in cache
   */
  setFileMetadata(fileId: string, file: FileInfo): void {
    const entry: CacheEntry<FileInfo> = {
      data: file,
      expiresAt: Date.now() + this.config.fileListTTL,
      createdAt: Date.now()
    };
    
    this.fileMetadataCache.set(fileId, entry);
    this.enforceMaxSize();
  }

  /**
   * Invalidate file metadata cache
   */
  invalidateFileMetadata(fileId: string): void {
    this.fileMetadataCache.delete(fileId);
  }

  // Cache Management

  /**
   * Check if cache entry is expired
   */
  private isExpired(entry: CacheEntry<unknown>): boolean {
    return Date.now() >= entry.expiresAt;
  }

  /**
   * Get current cache size in bytes
   */
  getCacheSize(): number {
    let size = 0;
    
    // Calculate vault metadata cache size
    this.vaultMetadataCache.forEach(entry => {
      size += JSON.stringify(entry.data).length;
    });
    
    // Calculate vaults list cache size
    if (this.vaultsListCache) {
      size += JSON.stringify(this.vaultsListCache.data).length;
    }
    
    // Calculate file list cache size
    this.fileListCache.forEach(entry => {
      size += JSON.stringify(entry.data).length;
    });
    
    // Calculate file hash cache size
    this.fileHashCache.forEach(entry => {
      size += entry.data.length;
    });
    
    // Calculate file metadata cache size
    this.fileMetadataCache.forEach(entry => {
      size += JSON.stringify(entry.data).length;
    });
    
    return size;
  }

  /**
   * Enforce maximum cache size by removing oldest entries
   */
  private enforceMaxSize(): void {
    const currentSize = this.getCacheSize();
    
    if (currentSize <= this.config.maxCacheSize) {
      return;
    }

    // Collect all entries with their creation times
    const entries: Array<{ key: string; createdAt: number; cache: string }> = [];
    
    this.vaultMetadataCache.forEach((entry, key) => {
      entries.push({ key, createdAt: entry.createdAt, cache: 'vaultMetadata' });
    });
    
    this.fileListCache.forEach((entry, key) => {
      entries.push({ key, createdAt: entry.createdAt, cache: 'fileList' });
    });
    
    this.fileHashCache.forEach((entry, key) => {
      entries.push({ key, createdAt: entry.createdAt, cache: 'fileHash' });
    });
    
    this.fileMetadataCache.forEach((entry, key) => {
      entries.push({ key, createdAt: entry.createdAt, cache: 'fileMetadata' });
    });
    
    // Sort by creation time (oldest first)
    entries.sort((a, b) => a.createdAt - b.createdAt);
    
    // Remove oldest entries until we're under the limit
    let removedCount = 0;
    for (const entry of entries) {
      if (this.getCacheSize() <= this.config.maxCacheSize) {
        break;
      }
      
      switch (entry.cache) {
        case 'vaultMetadata':
          this.vaultMetadataCache.delete(entry.key);
          break;
        case 'fileList':
          this.fileListCache.delete(entry.key);
          break;
        case 'fileHash':
          this.fileHashCache.delete(entry.key);
          break;
        case 'fileMetadata':
          this.fileMetadataCache.delete(entry.key);
          break;
      }
      
      removedCount++;
    }
    
    if (removedCount > 0) {
      console.debug(`Cache size limit reached. Removed ${removedCount} oldest entries.`);
    }
  }

  /**
   * Clear all expired entries
   */
  clearExpired(): void {
    // Clear expired vault metadata
    const expiredVaultMetadata: string[] = [];
    this.vaultMetadataCache.forEach((entry, key) => {
      if (this.isExpired(entry)) {
        expiredVaultMetadata.push(key);
      }
    });
    expiredVaultMetadata.forEach(key => this.vaultMetadataCache.delete(key));
    
    // Clear expired vaults list
    if (this.vaultsListCache && this.isExpired(this.vaultsListCache)) {
      this.vaultsListCache = null;
    }
    
    // Clear expired file lists
    const expiredFileLists: string[] = [];
    this.fileListCache.forEach((entry, key) => {
      if (this.isExpired(entry)) {
        expiredFileLists.push(key);
      }
    });
    expiredFileLists.forEach(key => this.fileListCache.delete(key));
    
    // Clear expired file hashes
    const expiredFileHashes: string[] = [];
    this.fileHashCache.forEach((entry, key) => {
      if (this.isExpired(entry)) {
        expiredFileHashes.push(key);
      }
    });
    expiredFileHashes.forEach(key => this.fileHashCache.delete(key));
    
    // Clear expired file metadata
    const expiredFileMetadata: string[] = [];
    this.fileMetadataCache.forEach((entry, key) => {
      if (this.isExpired(entry)) {
        expiredFileMetadata.push(key);
      }
    });
    expiredFileMetadata.forEach(key => this.fileMetadataCache.delete(key));
  }

  /**
   * Clear all caches
   */
  clearAll(): void {
    this.vaultMetadataCache.clear();
    this.vaultsListCache = null;
    this.fileListCache.clear();
    this.fileHashCache.clear();
    this.fileMetadataCache.clear();
  }

  /**
   * Clear cache for a specific vault
   */
  clearVaultCache(vaultId: string): void {
    this.invalidateVaultMetadata(vaultId);
    this.invalidateFileList(vaultId);
    this.invalidateVaultFileHashes(vaultId);
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    vaultMetadataCount: number;
    fileListCount: number;
    fileHashCount: number;
    fileMetadataCount: number;
    totalSize: number;
    maxSize: number;
    utilizationPercent: number;
  } {
    const totalSize = this.getCacheSize();
    
    return {
      vaultMetadataCount: this.vaultMetadataCache.size,
      fileListCount: this.fileListCache.size,
      fileHashCount: this.fileHashCache.size,
      fileMetadataCount: this.fileMetadataCache.size,
      totalSize,
      maxSize: this.config.maxCacheSize,
      utilizationPercent: (totalSize / this.config.maxCacheSize) * 100
    };
  }

  /**
   * Update cache configuration
   */
  updateConfig(config: Partial<CacheConfig>): void {
    this.config = { ...this.config, ...config };
    
    // Enforce new size limit if it was reduced
    if (config.maxCacheSize !== undefined) {
      this.enforceMaxSize();
    }
  }

  /**
   * Get cache configuration
   */
  getConfig(): CacheConfig {
    return { ...this.config };
  }
}
