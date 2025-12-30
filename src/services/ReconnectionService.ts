import { EventBus, EVENTS } from '../core/EventBus';
import { WebSocketManager, ConnectionState } from '../core/WebSocketManager';
import { SyncService } from './SyncService';
import { ConflictService } from './ConflictService';

/**
 * Reconnection Service
 * Handles state resynchronization after WebSocket reconnection
 */
export class ReconnectionService {
  private eventBus: EventBus;
  private wsManager: WebSocketManager;
  private syncService: SyncService;
  private conflictService: ConflictService;
  private unsubscribers: Array<() => void> = [];
  private wasDisconnected: boolean = false;
  private disconnectedAt: Date | null = null;

  constructor(
    eventBus: EventBus,
    wsManager: WebSocketManager,
    syncService: SyncService,
    conflictService: ConflictService
  ) {
    this.eventBus = eventBus;
    this.wsManager = wsManager;
    this.syncService = syncService;
    this.conflictService = conflictService;
  }

  /**
   * Initialize reconnection service
   */
  initialize(): void {
    // Listen for connection state changes
    const unsubConnectionChanged = this.eventBus.on(
      EVENTS.CONNECTION_CHANGED,
      (state: ConnectionState, data?: any) => {
        this.handleConnectionStateChange(state, data);
      }
    );
    
    this.unsubscribers.push(unsubConnectionChanged);
  }

  /**
   * Handle connection state changes
   */
  private async handleConnectionStateChange(state: ConnectionState, data?: any): Promise<void> {
    switch (state) {
      case ConnectionState.DISCONNECTED:
        this.handleDisconnection();
        break;
        
      case ConnectionState.RECONNECTING:
        this.handleReconnecting(data);
        break;
        
      case ConnectionState.CONNECTED:
        await this.handleReconnection();
        break;
        
      case ConnectionState.ERROR:
        this.handleConnectionError(data);
        break;
    }
  }

  /**
   * Handle disconnection
   */
  private handleDisconnection(): void {
    console.debug('[ReconnectionService] Connection lost');
    
    this.wasDisconnected = true;
    this.disconnectedAt = new Date();
    
    // Emit offline mode event
    this.eventBus.emit(EVENTS.OFFLINE_MODE_CHANGED, true);
  }

  /**
   * Handle reconnecting state
   */
  private handleReconnecting(attempt?: number): void {
    console.debug(`[ReconnectionService] Reconnecting... (attempt ${attempt || 0})`);
    
    // Could show a notification to user about reconnection attempts
  }

  /**
   * Handle successful reconnection
   */
  private async handleReconnection(): Promise<void> {
    if (!this.wasDisconnected) {
      // First connection, not a reconnection
      return;
    }

    console.debug('[ReconnectionService] Reconnected, resyncing state...');
    
    try {
      // Emit offline mode ended
      this.eventBus.emit(EVENTS.OFFLINE_MODE_CHANGED, false);
      
      // Resync state after reconnection
      await this.resyncState();
      
      console.debug('[ReconnectionService] State resync completed');
      
    } catch (error) {
      console.error('[ReconnectionService] Failed to resync state:', error);
      
      // Emit error event
      this.eventBus.emit(EVENTS.SYNC_ERROR, {
        message: 'Failed to resync after reconnection',
        error
      });
    } finally {
      this.wasDisconnected = false;
      this.disconnectedAt = null;
    }
  }

  /**
   * Handle connection error
   */
  private handleConnectionError(error?: any): void {
    console.error('[ReconnectionService] Connection error:', error);
  }

  /**
   * Resync state after reconnection
   */
  private async resyncState(): Promise<void> {
    console.debug('[ReconnectionService] Starting state resync...');
    
    // Step 1: Process queued sync operations
    await this.processQueuedOperations();
    
    // Step 2: Check for conflicts that occurred during offline period
    await this.checkForConflicts();
    
    // Step 3: Sync any changes that happened while offline
    await this.syncOfflineChanges();
    
    console.debug('[ReconnectionService] State resync completed');
  }

  /**
   * Process queued sync operations
   */
  private async processQueuedOperations(): Promise<void> {
    console.debug('[ReconnectionService] Processing queued operations...');
    
    try {
      // Get queued operations from sync service
      const queuedOperations = this.syncService.getQueue();
      
      if (queuedOperations.length === 0) {
        console.debug('[ReconnectionService] No queued operations');
        return;
      }
      
      console.debug(`[ReconnectionService] Processing ${queuedOperations.length} queued operations`);
      
      // The sync queue service will automatically process these operations
      // We just need to trigger a retry for any failed operations
      await this.syncService.retryFailed();
      
      console.debug('[ReconnectionService] Queued operations processing initiated');
      
    } catch (error) {
      console.error('[ReconnectionService] Failed to process queued operations:', error);
      throw error;
    }
  }

  /**
   * Check for conflicts that occurred during offline period
   */
  private async checkForConflicts(): Promise<void> {
    console.debug('[ReconnectionService] Checking for conflicts...');
    
    try {
      // Detect conflicts
      const conflicts = await this.conflictService.detectConflicts();
      
      if (conflicts.length > 0) {
        console.debug(`[ReconnectionService] Found ${conflicts.length} conflicts`);
        
        // Emit notification about conflicts
        this.eventBus.emit(EVENTS.CONFLICT_DETECTED, {
          count: conflicts.length,
          conflicts
        });
      } else {
        console.debug('[ReconnectionService] No conflicts found');
      }
      
    } catch (error) {
      console.error('[ReconnectionService] Failed to check for conflicts:', error);
      // Don't throw - conflicts can be detected later
    }
  }

  /**
   * Sync changes that happened while offline
   */
  private async syncOfflineChanges(): Promise<void> {
    if (!this.disconnectedAt) {
      return;
    }

    console.debug('[ReconnectionService] Syncing offline changes...');
    
    try {
      // Trigger a full sync to catch any changes
      // This will compare local and remote states
      await this.syncService.syncAll();
      
      console.debug('[ReconnectionService] Offline changes synced');
      
    } catch (error) {
      console.error('[ReconnectionService] Failed to sync offline changes:', error);
      throw error;
    }
  }

  /**
   * Get offline duration in seconds
   */
  getOfflineDuration(): number | null {
    if (!this.disconnectedAt) {
      return null;
    }
    
    const now = new Date();
    const durationMs = now.getTime() - this.disconnectedAt.getTime();
    return Math.floor(durationMs / 1000);
  }

  /**
   * Check if currently offline
   */
  isOffline(): boolean {
    return this.wasDisconnected;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.unsubscribers.forEach(unsubscribe => unsubscribe());
    this.unsubscribers = [];
  }
}
