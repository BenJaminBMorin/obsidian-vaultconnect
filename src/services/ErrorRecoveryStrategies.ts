import {
  ErrorRecoveryStrategy,
  PluginError,
  ErrorType
} from '../utils/errors';
import { AuthService } from './AuthService';
import { WebSocketManager } from '../core/WebSocketManager';
import { StorageManager } from '../core/StorageManager';

/**
 * Network reconnection strategy
 */
export class NetworkReconnectionStrategy implements ErrorRecoveryStrategy {
  description = 'Attempt to reconnect to the network';

  canRecover(error: PluginError): boolean {
    return error.type === ErrorType.NETWORK_ERROR && error.retryable;
  }

  async recover(error: PluginError): Promise<boolean> {
    // Wait a bit before checking connectivity
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if we can reach the internet using navigator.onLine
    // This is more reliable across platforms (desktop, mobile, web)
    return navigator.onLine;
  }
}

/**
 * WebSocket reconnection strategy
 */
export class WebSocketReconnectionStrategy implements ErrorRecoveryStrategy {
  description = 'Reconnect WebSocket connection';
  private wsManager: WebSocketManager;

  constructor(wsManager: WebSocketManager) {
    this.wsManager = wsManager;
  }

  canRecover(error: PluginError): boolean {
    return error.type === ErrorType.WEBSOCKET_ERROR && error.retryable;
  }

  async recover(error: PluginError): Promise<boolean> {
    try {
      // Disconnect if still connected
      if (this.wsManager.isConnected()) {
        await this.wsManager.disconnect();
      }

      // Wait a bit before reconnecting
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Attempt to reconnect
      // Note: The actual reconnection will be handled by the WebSocketManager's
      // auto-reconnect mechanism, so we just return true if we're not connected
      return !this.wsManager.isConnected();
    } catch {
      return false;
    }
  }
}

/**
 * Authentication refresh strategy
 */
export class AuthRefreshStrategy implements ErrorRecoveryStrategy {
  description = 'Refresh authentication token';
  private authService: AuthService;

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  canRecover(error: PluginError): boolean {
    // Can only recover if token is expired but we have a stored token
    return (
      error.type === ErrorType.AUTH_ERROR &&
      error.message.toLowerCase().includes('expired')
    );
  }

  async recover(error: PluginError): Promise<boolean> {
    try {
      // Check if we have a stored API key
      const apiKey = await this.authService.getApiKey();
      
      if (!apiKey) {
        // No stored key, can't recover automatically
        return false;
      }

      // If we have a key but it's expired, we can't auto-recover
      // User needs to re-authenticate
      return false;
    } catch {
      return false;
    }
  }
}

/**
 * Storage cleanup strategy
 */
export class StorageCleanupStrategy implements ErrorRecoveryStrategy {
  description = 'Clean up storage to free space';
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  canRecover(error: PluginError): boolean {
    return (
      error.type === ErrorType.STORAGE_ERROR &&
      (error.message.toLowerCase().includes('quota') ||
       error.message.toLowerCase().includes('space'))
    );
  }

  async recover(error: PluginError): Promise<boolean> {
    try {
      // Clear cache data
      this.storage.clearVaultCache();
      this.storage.clearFileCache();

      // Clear old sync logs (keep last 50)
      const logs = await this.storage.get<any[]>('syncLogs') || [];
      if (logs.length > 50) {
        await this.storage.set('syncLogs', logs.slice(0, 50));
      }

      // Clear resolved conflicts
      const conflicts = this.storage.getConflicts();
      const unresolvedConflicts = conflicts.filter((c: any) => !c.resolved);
      this.storage.clearConflicts();
      unresolvedConflicts.forEach((c: any) => this.storage.addConflict(c));

      await this.storage.save();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * File permission fix strategy
 */
export class FilePermissionStrategy implements ErrorRecoveryStrategy {
  description = 'Attempt to fix file permission issues';

  canRecover(error: PluginError): boolean {
    return (
      error.type === ErrorType.FILE_ERROR &&
      (error.message.toLowerCase().includes('permission') ||
       error.message.toLowerCase().includes('eacces'))
    );
  }

  async recover(error: PluginError): Promise<boolean> {
    // In Obsidian, we can't actually fix file permissions
    // But we can suggest the user check them
    console.warn('File permission error detected. Please check file permissions.');
    return false;
  }
}

/**
 * Conflict auto-resolution strategy
 */
export class ConflictAutoResolveStrategy implements ErrorRecoveryStrategy {
  description = 'Automatically resolve simple conflicts';

  canRecover(error: PluginError): boolean {
    return (
      error.type === ErrorType.CONFLICT_ERROR &&
      error.context?.autoResolvable === true
    );
  }

  async recover(error: PluginError): Promise<boolean> {
    // This would need access to the ConflictService
    // For now, we just return false as conflicts should be manually resolved
    return false;
  }
}

/**
 * Sync queue retry strategy
 */
export class SyncQueueRetryStrategy implements ErrorRecoveryStrategy {
  description = 'Retry failed sync operations from queue';

  canRecover(error: PluginError): boolean {
    return error.type === ErrorType.SYNC_ERROR && error.retryable;
  }

  async recover(error: PluginError): Promise<boolean> {
    // The sync queue service handles retries automatically
    // This strategy just confirms that retry is possible
    return true;
  }
}

/**
 * Cache invalidation strategy
 */
export class CacheInvalidationStrategy implements ErrorRecoveryStrategy {
  description = 'Invalidate and refresh cache';
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  canRecover(error: PluginError): boolean {
    return (
      error.message.toLowerCase().includes('cache') ||
      error.message.toLowerCase().includes('stale')
    );
  }

  async recover(error: PluginError): Promise<boolean> {
    try {
      // Clear all cache
      this.storage.clearVaultCache();
      this.storage.clearFileCache();
      await this.storage.save();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Get all default recovery strategies
 */
export function getDefaultRecoveryStrategies(
  authService: AuthService,
  wsManager: WebSocketManager,
  storage: StorageManager
): Map<ErrorType, ErrorRecoveryStrategy[]> {
  const strategies = new Map<ErrorType, ErrorRecoveryStrategy[]>();

  // Network error strategies
  strategies.set(ErrorType.NETWORK_ERROR, [
    new NetworkReconnectionStrategy()
  ]);

  // WebSocket error strategies
  strategies.set(ErrorType.WEBSOCKET_ERROR, [
    new WebSocketReconnectionStrategy(wsManager)
  ]);

  // Auth error strategies
  strategies.set(ErrorType.AUTH_ERROR, [
    new AuthRefreshStrategy(authService)
  ]);

  // Storage error strategies
  strategies.set(ErrorType.STORAGE_ERROR, [
    new StorageCleanupStrategy(storage)
  ]);

  // File error strategies
  strategies.set(ErrorType.FILE_ERROR, [
    new FilePermissionStrategy()
  ]);

  // Conflict error strategies
  strategies.set(ErrorType.CONFLICT_ERROR, [
    new ConflictAutoResolveStrategy()
  ]);

  // Sync error strategies
  strategies.set(ErrorType.SYNC_ERROR, [
    new SyncQueueRetryStrategy(),
    new CacheInvalidationStrategy(storage)
  ]);

  return strategies;
}
