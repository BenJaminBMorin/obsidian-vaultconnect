import { EventBus, EVENTS } from '../core/EventBus';
import { logger } from '../utils/logger';

/**
 * Network status
 */
export enum NetworkStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  CHECKING = 'checking'
}

/**
 * Offline detection configuration
 */
export interface OfflineDetectionConfig {
  checkInterval: number; // milliseconds
  timeout: number; // milliseconds
  maxRetries: number;
}

/**
 * Service for detecting network connectivity and managing offline mode
 */
export class OfflineDetectionService {
  private eventBus: EventBus;
  private config: OfflineDetectionConfig;
  private networkStatus: NetworkStatus = NetworkStatus.CHECKING;
  private isOfflineMode: boolean = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private isMonitoring: boolean = false;

  constructor(
    eventBus: EventBus,
    config: OfflineDetectionConfig
  ) {
    this.eventBus = eventBus;
    this.config = config;
  }

  /**
   * Start monitoring network connectivity
   */
  startMonitoring(): void {
    if (this.isMonitoring) {
      console.debug('OfflineDetectionService: Already monitoring');
      return;
    }

    this.isMonitoring = true;
    console.debug('OfflineDetectionService: Started monitoring');

    // Set up browser online/offline event listeners
    this.setupBrowserListeners();

    // Perform initial connectivity check
    void this.checkConnectivity();

    // Set up periodic connectivity checks
    this.checkInterval = setInterval(() => {
      void this.checkConnectivity();
    }, this.config.checkInterval);
  }

  /**
   * Stop monitoring network connectivity
   */
  stopMonitoring(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;
    console.debug('OfflineDetectionService: Stopped monitoring');

    // Remove browser event listeners
    this.removeBrowserListeners();

    // Clear interval
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Setup browser online/offline event listeners
   */
  private setupBrowserListeners(): void {
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
  }

  /**
   * Remove browser event listeners
   */
  private removeBrowserListeners(): void {
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
  }

  /**
   * Handle browser online event
   */
  private handleOnline = (): void => {
    console.debug('OfflineDetectionService: Browser online event');
    void this.checkConnectivity();
  };

  /**
   * Handle browser offline event
   */
  private handleOffline = (): void => {
    console.debug('OfflineDetectionService: Browser offline event');
    this.setNetworkStatus(NetworkStatus.OFFLINE);
    this.enterOfflineMode();
  };

  /**
   * Check network connectivity
   */
  private checkConnectivity(): void {
    // Quick check: browser navigator.onLine
    if (!navigator.onLine) {
      this.setNetworkStatus(NetworkStatus.OFFLINE);
      this.enterOfflineMode();
      return;
    }

    // Use navigator.onLine as the primary indicator
    // This is more reliable across platforms (desktop, mobile, web)
    this.setNetworkStatus(NetworkStatus.CHECKING);

    if (navigator.onLine) {
      // If we got here, we have connectivity
      this.setNetworkStatus(NetworkStatus.ONLINE);

      // Exit offline mode if we were in it
      if (this.isOfflineMode) {
        this.exitOfflineMode();
      }
    } else {
      logger.debug('OfflineDetectionService: Navigator reports offline');
      this.setNetworkStatus(NetworkStatus.OFFLINE);
      this.enterOfflineMode();
    }
  }

  /**
   * Set network status
   */
  private setNetworkStatus(status: NetworkStatus): void {
    if (this.networkStatus !== status) {
      const oldStatus = this.networkStatus;
      this.networkStatus = status;
      console.debug(`OfflineDetectionService: Network status changed from ${oldStatus} to ${status}`);
      this.eventBus.emit('network:status-changed', status, oldStatus);
    }
  }

  /**
   * Enter offline mode
   */
  private enterOfflineMode(): void {
    if (this.isOfflineMode) {
      return;
    }

    this.isOfflineMode = true;
    console.debug('OfflineDetectionService: Entering offline mode');
    
    // Emit offline mode event
    this.eventBus.emit(EVENTS.OFFLINE_MODE_CHANGED, true);
    
    // Notify user
    this.eventBus.emit('notification:show', {
      message: 'You are now offline. Changes will be queued and synced when connection is restored.',
      type: 'info',
      duration: 5000
    });
  }

  /**
   * Exit offline mode
   */
  private exitOfflineMode(): void {
    if (!this.isOfflineMode) {
      return;
    }

    this.isOfflineMode = false;
    console.debug('OfflineDetectionService: Exiting offline mode');
    
    // Emit offline mode event
    this.eventBus.emit(EVENTS.OFFLINE_MODE_CHANGED, false);
    
    // Notify user
    this.eventBus.emit('notification:show', {
      message: 'Connection restored. Syncing queued changes...',
      type: 'success',
      duration: 3000
    });
  }

  /**
   * Force offline mode (for testing or manual control)
   */
  forceOfflineMode(offline: boolean): void {
    if (offline) {
      this.setNetworkStatus(NetworkStatus.OFFLINE);
      this.enterOfflineMode();
    } else {
      void this.checkConnectivity();
    }
  }

  /**
   * Get current network status
   */
  getNetworkStatus(): NetworkStatus {
    return this.networkStatus;
  }

  /**
   * Check if in offline mode
   */
  isOffline(): boolean {
    return this.isOfflineMode;
  }

  /**
   * Check if online
   */
  isOnline(): boolean {
    return this.networkStatus === NetworkStatus.ONLINE && !this.isOfflineMode;
  }

  /**
   * Manual connectivity check
   */
  checkNow(): NetworkStatus {
    this.checkConnectivity();
    return this.networkStatus;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<OfflineDetectionConfig>): void {
    this.config = { ...this.config, ...config };
    
    // Restart monitoring if interval changed
    if (config.checkInterval !== undefined && this.isMonitoring) {
      this.stopMonitoring();
      this.startMonitoring();
    }
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.stopMonitoring();
  }
}
