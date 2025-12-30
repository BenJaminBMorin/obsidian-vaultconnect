import { StorageManager } from '../core/StorageManager';

/**
 * Persisted upload state
 */
export interface PersistedUploadState {
  uploadId: string;
  vaultId: string;
  filePath: string;
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  uploadedChunks: number[];
  startTime: number;
  lastUpdate: number;
  contentHash: string;
  fileModTime: number; // File modification time for validation
}

/**
 * Upload Persistence Service
 * Manages persistent storage of upload state for resume capability
 */
export class UploadPersistenceService {
  private storage: StorageManager;
  private storageKey = 'vaultsync-upload-states';
  private maxAge = 24 * 60 * 60 * 1000; // 24 hours

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  /**
   * Save upload state
   */
  async saveUploadState(state: PersistedUploadState): Promise<void> {
    try {
      const existing = await this.loadAllStates();
      existing[state.uploadId] = {
        ...state,
        lastUpdate: Date.now()
      };
      
      await this.storage.set(this.storageKey, existing);
      console.debug(`[UploadPersistence] Saved state for ${state.filePath} (${state.uploadedChunks.length}/${state.totalChunks} chunks)`);
    } catch (error) {
      console.error('[UploadPersistence] Failed to save upload state:', error);
    }
  }

  /**
   * Load all persisted states
   */
  async loadAllStates(): Promise<Record<string, PersistedUploadState>> {
    try {
      const states = await this.storage.get<Record<string, PersistedUploadState>>(this.storageKey);
      return states || {};
    } catch (error) {
      console.error('[UploadPersistence] Failed to load upload states:', error);
      return {};
    }
  }

  /**
   * Load state for specific upload
   */
  async loadState(uploadId: string): Promise<PersistedUploadState | null> {
    const states = await this.loadAllStates();
    return states[uploadId] || null;
  }

  /**
   * Delete state
   */
  async deleteState(uploadId: string): Promise<void> {
    try {
      const states = await this.loadAllStates();
      delete states[uploadId];
      await this.storage.set(this.storageKey, states);
      console.debug(`[UploadPersistence] Deleted state for ${uploadId}`);
    } catch (error) {
      console.error('[UploadPersistence] Failed to delete upload state:', error);
    }
  }

  /**
   * Clean up old states (>24 hours)
   */
  async cleanupOldStates(): Promise<number> {
    try {
      const states = await this.loadAllStates();
      const now = Date.now();
      let cleanedCount = 0;
      
      const cleaned = Object.entries(states)
        .filter(([_, state]) => {
          const age = now - state.lastUpdate;
          if (age > this.maxAge) {
            cleanedCount++;
            return false;
          }
          return true;
        })
        .reduce((acc, [id, state]) => ({ ...acc, [id]: state }), {});
      
      if (cleanedCount > 0) {
        await this.storage.set(this.storageKey, cleaned);
        console.debug(`[UploadPersistence] Cleaned up ${cleanedCount} old upload state(s)`);
      }
      
      return cleanedCount;
    } catch (error) {
      console.error('[UploadPersistence] Failed to cleanup old states:', error);
      return 0;
    }
  }

  /**
   * Get resumable uploads (not too old, has progress)
   */
  async getResumableUploads(): Promise<PersistedUploadState[]> {
    await this.cleanupOldStates();
    
    const states = await this.loadAllStates();
    return Object.values(states)
      .filter(state => {
        // Must have uploaded at least one chunk
        if (state.uploadedChunks.length === 0) return false;
        
        // Must not be complete
        if (state.uploadedChunks.length >= state.totalChunks) return false;
        
        // Must be recent enough
        const age = Date.now() - state.lastUpdate;
        if (age > this.maxAge) return false;
        
        return true;
      })
      .sort((a, b) => b.lastUpdate - a.lastUpdate); // Most recent first
  }

  /**
   * Compute content hash for validation
   */
  async computeContentHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    totalStates: number;
    resumableStates: number;
    oldestState: number | null;
    newestState: number | null;
  }> {
    const states = await this.loadAllStates();
    const stateArray = Object.values(states);
    const resumable = await this.getResumableUploads();
    
    const timestamps = stateArray.map(s => s.lastUpdate);
    
    return {
      totalStates: stateArray.length,
      resumableStates: resumable.length,
      oldestState: timestamps.length > 0 ? Math.min(...timestamps) : null,
      newestState: timestamps.length > 0 ? Math.max(...timestamps) : null
    };
  }

  /**
   * Clear all states (for testing/debugging)
   */
  async clearAllStates(): Promise<void> {
    await this.storage.set(this.storageKey, {});
    console.debug('[UploadPersistence] Cleared all upload states');
  }
}
