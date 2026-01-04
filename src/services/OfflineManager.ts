import { Vault } from 'obsidian';
import { APIClient } from '../api/APIClient';
import { EventBus, EVENTS } from '../core/EventBus';
import { StorageManager } from '../core/StorageManager';
import { OfflineDetectionService, NetworkStatus } from './OfflineDetectionService';
import { OfflineQueueService } from './OfflineQueueService';
import { OfflineSyncService } from './OfflineSyncService';
import { FileSyncService } from './FileSyncService';

/**
 * File sync event data
 */
interface FileSyncEvent {
  path: string;
  action: 'create' | 'modify' | 'delete' | 'rename';
  content?: string;
  oldPath?: string;
}

/**
 * Offline manager configuration
 */
export interface OfflineManagerConfig {
  enabled: boolean;
  checkInterval: number;
  timeout: number;
  maxRetries: number;
  maxQueueSize: number;
}

/**
 * Manager that orchestrates all offline mode functionality
 */
export class OfflineManager {
  private vault: Vault;
  private apiClient: APIClient;
  private eventBus: EventBus;
  private storage: StorageManager;
  private fileSync: FileSyncService;
  
  private offlineDetection: OfflineDetectionService;
  private offlineQueue: OfflineQueueService;
  private offlineSync: OfflineSyncService;
  
  private config: OfflineManagerConfig;
  private isInitialized: boolean = false;
  private vaultId: string | null = null;

  constructor(
    vault: Vault,
    apiClient: APIClient,
    eventBus: EventBus,
    storage: StorageManager,
    fileSync: FileSyncService,
    config: OfflineManagerConfig
  ) {
    this.vault = vault;
    this.apiClient = apiClient;
    this.eventBus = eventBus;
    this.storage = storage;
    this.fileSync = fileSync;
    this.config = config;

    // Initialize offline services
    this.offlineDetection = new OfflineDetectionService(
      eventBus,
      {
        checkInterval: config.checkInterval,
        timeout: config.timeout,
        maxRetries: config.maxRetries
      }
    );

    this.offlineQueue = new OfflineQueueService(
      eventBus,
      storage,
      config.maxQueueSize
    );

    this.offlineSync = new OfflineSyncService(
      vault,
      apiClient,
      eventBus,
      storage,
      this.offlineQueue,
      fileSync
    );

    this.setupEventListeners();
  }

  /**
   * Initialize offline manager
   */
  async initialize(vaultId: string): Promise<void> {
    if (this.isInitialized) {
      console.debug('OfflineManager: Already initialized');
      return;
    }

    this.vaultId = vaultId;

    // Initialize offline queue
    await this.offlineQueue.initialize();

    // Initialize offline sync
    this.offlineSync.initialize(vaultId);

    this.isInitialized = true;
    console.debug('OfflineManager: Initialized');
  }

  /**
   * Start offline manager
   */
  start(): void {
    if (!this.isInitialized) {
      throw new Error('OfflineManager not initialized');
    }

    if (!this.config.enabled) {
      console.debug('OfflineManager: Offline mode disabled in config');
      return;
    }

    // Start offline detection
    this.offlineDetection.startMonitoring();

    console.debug('OfflineManager: Started');
  }

  /**
   * Stop offline manager
   */
  stop(): void {
    // Stop offline detection
    this.offlineDetection.stopMonitoring();

    console.debug('OfflineManager: Stopped');
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen for file changes to queue during offline mode
    this.eventBus.on(EVENTS.FILE_SYNCED, (event: FileSyncEvent) => {
      void (async () => {
        if (this.offlineDetection.isOffline()) {
          // Queue the operation
          await this.queueFileOperation(event);
        }
      })();
    });

    // Listen for offline mode changes to disable real-time features
    this.eventBus.on(EVENTS.OFFLINE_MODE_CHANGED, (offline: boolean) => {
      if (offline) {
        this.disableRealtimeFeatures();
      } else {
        this.enableRealtimeFeatures();
      }
    });
  }

  /**
   * Queue file operation during offline mode
   */
  private async queueFileOperation(event: FileSyncEvent): Promise<void> {
    try {
      const { path, action, content, oldPath } = event;
      
      let operation: 'create' | 'update' | 'delete' | 'rename';
      
      switch (action) {
        case 'create':
          operation = 'create';
          break;
        case 'modify':
          operation = 'update';
          break;
        case 'delete':
          operation = 'delete';
          break;
        case 'rename':
          operation = 'rename';
          break;
        default:
          console.warn(`OfflineManager: Unknown action type: ${String(action)}`);
          return;
      }

      await this.offlineQueue.enqueue(path, operation, content, oldPath);
      console.debug(`OfflineManager: Queued ${operation} operation for ${path}`);
    } catch (error) {
      console.error('OfflineManager: Error queuing operation:', error);
    }
  }

  /**
   * Disable real-time features during offline mode
   */
  private disableRealtimeFeatures(): void {
    console.debug('OfflineManager: Disabling real-time features');
    
    // Emit event to disable collaboration
    this.eventBus.emit('collaboration:disable');
    
    // Emit event to disable presence
    this.eventBus.emit('presence:disable');
    
    // Emit event to disable WebSocket
    this.eventBus.emit('websocket:disable');
  }

  /**
   * Enable real-time features when back online
   */
  private enableRealtimeFeatures(): void {
    console.debug('OfflineManager: Enabling real-time features');
    
    // Emit event to enable collaboration
    this.eventBus.emit('collaboration:enable');
    
    // Emit event to enable presence
    this.eventBus.emit('presence:enable');
    
    // Emit event to enable WebSocket
    this.eventBus.emit('websocket:enable');
  }

  /**
   * Manually queue an operation
   */
  async queueOperation(
    path: string,
    operation: 'create' | 'update' | 'delete' | 'rename',
    content?: string,
    oldPath?: string
  ): Promise<string> {
    return await this.offlineQueue.enqueue(path, operation, content, oldPath);
  }

  /**
   * Get offline queue service
   */
  getOfflineQueue(): OfflineQueueService {
    return this.offlineQueue;
  }

  /**
   * Get offline sync service
   */
  getOfflineSync(): OfflineSyncService {
    return this.offlineSync;
  }

  /**
   * Get offline detection service
   */
  getOfflineDetection(): OfflineDetectionService {
    return this.offlineDetection;
  }

  /**
   * Check if in offline mode
   */
  isOffline(): boolean {
    return this.offlineDetection.isOffline();
  }

  /**
   * Check if online
   */
  isOnline(): boolean {
    return this.offlineDetection.isOnline();
  }

  /**
   * Get network status
   */
  getNetworkStatus(): NetworkStatus {
    return this.offlineDetection.getNetworkStatus();
  }

  /**
   * Get queue statistics
   */
  getQueueStats() {
    return this.offlineQueue.getStats();
  }

  /**
   * Manually trigger sync
   */
  async syncNow() {
    if (this.isOffline()) {
      throw new Error('Cannot sync while offline');
    }

    return await this.offlineSync.syncNow();
  }

  /**
   * Force offline mode (for testing)
   */
  forceOfflineMode(offline: boolean): void {
    this.offlineDetection.forceOfflineMode(offline);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<OfflineManagerConfig>): void {
    this.config = { ...this.config, ...config };

    // Update offline detection config
    if (config.checkInterval !== undefined || config.timeout !== undefined || config.maxRetries !== undefined) {
      this.offlineDetection.updateConfig({
        checkInterval: this.config.checkInterval,
        timeout: this.config.timeout,
        maxRetries: this.config.maxRetries
      });
    }

    // Handle enabled/disabled state
    if (config.enabled !== undefined) {
      if (config.enabled && this.isInitialized) {
        this.start();
      } else {
        this.stop();
      }
    }
  }

  /**
   * Check if offline mode is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.stop();
    this.offlineDetection.destroy();
    this.offlineQueue.destroy();
  }
}
