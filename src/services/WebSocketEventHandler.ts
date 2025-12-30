import { EventBus, EVENTS } from '../core/EventBus';
import { WebSocketManager } from '../core/WebSocketManager';
import { WS_EVENTS } from '../utils/constants';
import { ConflictInfo, FileInfo, ActiveUser } from '../types';

/**
 * WebSocket Event Handler
 * Processes WebSocket events and emits plugin events
 */
export class WebSocketEventHandler {
  private wsManager: WebSocketManager;
  private eventBus: EventBus;
  private unsubscribers: Array<() => void> = [];

  constructor(wsManager: WebSocketManager, eventBus: EventBus) {
    this.wsManager = wsManager;
    this.eventBus = eventBus;
  }

  /**
   * Initialize event handlers
   */
  initialize(): void {
    this.setupSyncEventHandlers();
    this.setupDeviceEventHandlers();
    this.setupConflictEventHandlers();
    this.setupPresenceEventHandlers();
    this.setupCollaborationEventHandlers();
  }

  /**
   * Setup sync event handlers
   */
  private setupSyncEventHandlers(): void {
    // Handle sync_event - file updated from another device
    const unsubSyncEvent = this.wsManager.on(WS_EVENTS.SYNC_EVENT, (data: any) => {
      console.debug('Received sync event:', data);
      
      const fileInfo: Partial<FileInfo> = {
        file_id: data.file_id,
        vault_id: data.vault_id,
        path: data.path,
        hash: data.hash,
        updated_at: new Date(data.updated_at)
      };
      
      // Emit to sync service
      this.eventBus.emit(EVENTS.FILE_SYNCED, {
        file: fileInfo,
        source: 'remote',
        deviceId: data.device_id,
        operation: data.operation // 'create', 'update', 'delete'
      });
    });
    
    this.unsubscribers.push(unsubSyncEvent);

    // Handle file_update - real-time file update notification
    const unsubFileUpdate = this.wsManager.on(WS_EVENTS.FILE_UPDATE, (data: any) => {
      console.debug('Received file update:', data);
      
      // Emit to sync service for processing
      this.eventBus.emit(EVENTS.FILE_SYNCED, {
        file: {
          file_id: data.file_id,
          path: data.path,
          hash: data.hash,
          updated_at: new Date(data.updated_at)
        },
        source: 'remote',
        deviceId: data.device_id,
        operation: data.operation
      });
      
      // Send acknowledgment
      this.wsManager.send(WS_EVENTS.FILE_UPDATE_ACK, {
        file_id: data.file_id,
        received_at: Date.now()
      });
    });
    
    this.unsubscribers.push(unsubFileUpdate);
  }

  /**
   * Setup device event handlers
   */
  private setupDeviceEventHandlers(): void {
    // Handle device_connected - another device connected to vault
    const unsubDeviceConnected = this.wsManager.on(WS_EVENTS.DEVICE_CONNECTED, (data: any) => {
      console.debug('Device connected:', data);
      
      // Emit notification event
      this.eventBus.emit(EVENTS.CONNECTION_CHANGED, 'device_connected', {
        deviceId: data.device_id,
        deviceName: data.device_name,
        timestamp: new Date(data.timestamp)
      });
    });
    
    this.unsubscribers.push(unsubDeviceConnected);

    // Handle device_disconnected - another device disconnected from vault
    const unsubDeviceDisconnected = this.wsManager.on(WS_EVENTS.DEVICE_DISCONNECTED, (data: any) => {
      console.debug('Device disconnected:', data);
      
      // Emit notification event
      this.eventBus.emit(EVENTS.CONNECTION_CHANGED, 'device_disconnected', {
        deviceId: data.device_id,
        deviceName: data.device_name,
        timestamp: new Date(data.timestamp)
      });
    });
    
    this.unsubscribers.push(unsubDeviceDisconnected);
  }

  /**
   * Setup conflict event handlers
   */
  private setupConflictEventHandlers(): void {
    // Handle conflict - conflict detected
    const unsubConflict = this.wsManager.on(WS_EVENTS.CONFLICT, (data: any) => {
      console.debug('Conflict detected:', data);
      
      const conflictInfo: ConflictInfo = {
        id: data.conflict_id,
        path: data.path,
        localContent: data.local_content || '',
        remoteContent: data.remote_content || '',
        localModified: new Date(data.local_modified),
        remoteModified: new Date(data.remote_modified),
        conflictType: data.conflict_type,
        autoResolvable: data.auto_resolvable || false
      };
      
      // Emit to conflict service
      this.eventBus.emit(EVENTS.CONFLICT_DETECTED, conflictInfo);
    });
    
    this.unsubscribers.push(unsubConflict);

    // Handle conflict_resolved - conflict resolved by another device
    const unsubConflictResolved = this.wsManager.on(WS_EVENTS.CONFLICT_RESOLVED, (data: any) => {
      console.debug('Conflict resolved:', data);
      
      // Emit to conflict service
      this.eventBus.emit(EVENTS.CONFLICT_RESOLVED, {
        conflictId: data.conflict_id,
        path: data.path,
        resolution: data.resolution,
        resolvedBy: data.resolved_by,
        timestamp: new Date(data.timestamp)
      });
    });
    
    this.unsubscribers.push(unsubConflictResolved);
  }

  /**
   * Setup presence event handlers
   */
  private setupPresenceEventHandlers(): void {
    // Handle user_joined - user joined vault
    const unsubUserJoined = this.wsManager.on(WS_EVENTS.USER_JOINED, (data: any) => {
      console.debug('User joined:', data);
      
      const user: ActiveUser = {
        userId: data.user_id,
        userName: data.user_name,
        userAvatar: data.user_avatar,
        status: 'active',
        currentFile: data.current_file || null,
        lastActivity: new Date(data.timestamp)
      };
      
      // Emit to presence service
      this.eventBus.emit(EVENTS.USER_JOINED, user);
    });
    
    this.unsubscribers.push(unsubUserJoined);

    // Handle user_left - user left vault
    const unsubUserLeft = this.wsManager.on(WS_EVENTS.USER_LEFT, (data: any) => {
      console.debug('User left:', data);
      
      // Emit to presence service
      this.eventBus.emit(EVENTS.USER_LEFT, {
        userId: data.user_id,
        userName: data.user_name,
        timestamp: new Date(data.timestamp)
      });
    });
    
    this.unsubscribers.push(unsubUserLeft);

    // Handle presence_update - user presence changed
    const unsubPresenceUpdate = this.wsManager.on(WS_EVENTS.PRESENCE_UPDATE, (data: any) => {
      console.debug('Presence update:', data);
      
      // Emit to presence service
      this.eventBus.emit(EVENTS.USER_ACTIVITY, {
        userId: data.user_id,
        status: data.status, // 'active', 'away', 'offline'
        currentFile: data.current_file,
        lastActivity: new Date(data.timestamp)
      });
    });
    
    this.unsubscribers.push(unsubPresenceUpdate);
  }

  /**
   * Setup collaboration event handlers
   */
  private setupCollaborationEventHandlers(): void {
    // Handle collaborator_joined - user opened same file
    const unsubCollabJoined = this.wsManager.on(WS_EVENTS.COLLABORATOR_JOINED, (data: any) => {
      console.debug('Collaborator joined:', data);
      
      // Emit to collaboration service
      this.eventBus.emit(EVENTS.COLLABORATOR_JOINED, {
        userId: data.user_id,
        userName: data.user_name,
        userAvatar: data.user_avatar,
        color: data.color,
        filePath: data.file_path,
        timestamp: new Date(data.timestamp)
      });
      
      // Also emit file opened event
      this.eventBus.emit(EVENTS.FILE_OPENED, {
        userId: data.user_id,
        filePath: data.file_path
      });
    });
    
    this.unsubscribers.push(unsubCollabJoined);

    // Handle collaborator_left - user closed file
    const unsubCollabLeft = this.wsManager.on(WS_EVENTS.COLLABORATOR_LEFT, (data: any) => {
      console.debug('Collaborator left:', data);
      
      // Emit to collaboration service
      this.eventBus.emit(EVENTS.COLLABORATOR_LEFT, {
        userId: data.user_id,
        userName: data.user_name,
        filePath: data.file_path,
        timestamp: new Date(data.timestamp)
      });
      
      // Also emit file closed event
      this.eventBus.emit(EVENTS.FILE_CLOSED, {
        userId: data.user_id,
        filePath: data.file_path
      });
    });
    
    this.unsubscribers.push(unsubCollabLeft);

    // Handle cursor_update - cursor position changed
    const unsubCursorUpdate = this.wsManager.on(WS_EVENTS.CURSOR_UPDATE, (data: any) => {
      // Don't log cursor updates (too frequent)
      
      // Emit to collaboration service
      this.eventBus.emit(EVENTS.CURSOR_UPDATE, {
        userId: data.user_id,
        filePath: data.file_path,
        cursor: data.cursor,
        selection: data.selection
      });
    });
    
    this.unsubscribers.push(unsubCursorUpdate);

    // Handle typing_indicator - user is typing
    const unsubTypingIndicator = this.wsManager.on(WS_EVENTS.TYPING_INDICATOR, (data: any) => {
      // Don't log typing indicators (too frequent)
      
      // Emit to collaboration service
      this.eventBus.emit(EVENTS.CURSOR_UPDATE, {
        userId: data.user_id,
        filePath: data.file_path,
        isTyping: data.is_typing
      });
    });
    
    this.unsubscribers.push(unsubTypingIndicator);
  }

  /**
   * Cleanup event handlers
   */
  destroy(): void {
    // Unsubscribe from all events
    this.unsubscribers.forEach(unsubscribe => unsubscribe());
    this.unsubscribers = [];
  }
}
