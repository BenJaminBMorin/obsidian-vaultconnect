import { Plugin, TFile } from 'obsidian';
import { EventBus, EVENTS } from '../core/EventBus';
import { WebSocketManager } from '../core/WebSocketManager';
import { StorageManager } from '../core/StorageManager';
import { ActiveUser, PresenceState } from '../types';
import { WS_EVENTS, PRESENCE_HEARTBEAT_MS, IDLE_TIMEOUT_MS } from '../utils/constants';
import { parseErrorMessage } from '../utils/helpers';

/**
 * WebSocket presence event data interfaces
 */
interface WsUserJoinedData {
  user_id: string;
  user_name: string;
  user_avatar?: string;
  vault_id: string;
}

interface WsUserLeftData {
  user_id: string;
}

interface WsPresenceUpdateData {
  user_id: string;
  user_name: string;
  user_avatar?: string;
  status: 'active' | 'away' | 'offline';
  current_file?: string | null;
  last_activity: string;
}

export interface UserActivity {
  type: 'viewing' | 'editing' | 'idle';
  filePath: string | null;
  timestamp: Date;
}

/**
 * Presence Service
 * Tracks active users and their activities in the vault
 */
export class PresenceService {
  private plugin: Plugin;
  private eventBus: EventBus;
  private wsManager: WebSocketManager;
  private storage: StorageManager;
  
  // Current user state
  private currentVaultId: string | null = null;
  private currentUserId: string | null = null;
  private currentUserName: string | null = null;
  private currentFile: string | null = null;
  private lastActivity: Date = new Date();
  private isIdle: boolean = false;
  
  // Active users tracking
  private activeUsers: Map<string, ActiveUser> = new Map();
  private fileViewers: Map<string, Set<string>> = new Map(); // filePath -> Set<userId>
  
  // Heartbeat
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  
  // Activity tracking
  private activityListeners: (() => void)[] = [];
  
  private debugMode: boolean = false;

  constructor(
    plugin: Plugin,
    eventBus: EventBus,
    wsManager: WebSocketManager,
    storage: StorageManager,
    debugMode: boolean = false
  ) {
    this.plugin = plugin;
    this.eventBus = eventBus;
    this.wsManager = wsManager;
    this.storage = storage;
    this.debugMode = debugMode;
  }

  /**
   * Initialize presence service
   */
  initialize(): void {
    this.log('Initializing presence service');
    
    // Load cached active users
    const cachedUsers = this.storage.getActiveUsers();
    if (cachedUsers) {
      Object.entries(cachedUsers).forEach(([userId, user]) => {
        this.activeUsers.set(userId, user);
      });
    }
    
    // Load cached file viewers
    const cachedViewers = this.storage.getFileViewers();
    if (cachedViewers) {
      Object.entries(cachedViewers).forEach(([filePath, userIds]) => {
        this.fileViewers.set(filePath, new Set(userIds));
      });
    }
    
    // Set up WebSocket event listeners
    this.setupWebSocketListeners();
    
    // Set up activity tracking
    this.setupActivityTracking();
    
    // Start idle checking
    this.startIdleCheck();
    
    this.log('Presence service initialized');
  }

  /**
   * Start presence tracking for a vault
   */
  async startTracking(vaultId: string, userId: string, userName: string): Promise<void> {
    this.log(`Starting presence tracking for vault ${vaultId}`);
    
    this.currentVaultId = vaultId;
    this.currentUserId = userId;
    this.currentUserName = userName;
    this.lastActivity = new Date();
    this.isIdle = false;
    
    // Broadcast initial presence
    await this.broadcastPresence();
    
    // Start heartbeat
    this.startHeartbeat();
    
    this.log('Presence tracking started');
  }

  /**
   * Stop presence tracking
   */
  async stopTracking(): Promise<void> {
    this.log('Stopping presence tracking');
    
    // Broadcast offline status
    if (this.currentVaultId && this.currentUserId) {
      await this.broadcastPresence('offline');
    }
    
    // Stop heartbeat
    this.stopHeartbeat();
    
    // Stop idle check
    this.stopIdleCheck();
    
    // Clear state
    this.currentVaultId = null;
    this.currentUserId = null;
    this.currentUserName = null;
    this.currentFile = null;
    this.activeUsers.clear();
    this.fileViewers.clear();
    
    this.log('Presence tracking stopped');
  }

  /**
   * Broadcast user presence
   */
  async broadcastPresence(status?: 'active' | 'away' | 'offline'): Promise<void> {
    if (!this.currentVaultId || !this.currentUserId) {
      return;
    }

    const presenceState: PresenceState = {
      userId: this.currentUserId,
      vaultId: this.currentVaultId,
      status: status || (this.isIdle ? 'away' : 'active'),
      currentFile: this.currentFile,
      lastActivity: this.lastActivity
    };

    this.log('Broadcasting presence', presenceState);
    
    // Send via WebSocket
    this.wsManager.send(WS_EVENTS.PRESENCE_UPDATE, presenceState);
  }

  /**
   * Update user activity
   */
  async updateActivity(activity: UserActivity): Promise<void> {
    this.lastActivity = new Date();
    
    // If was idle, mark as active again
    if (this.isIdle) {
      this.isIdle = false;
      await this.broadcastPresence('active');
    }
    
    // Update current file if changed
    if (activity.filePath !== this.currentFile) {
      const oldFile = this.currentFile;
      this.currentFile = activity.filePath;
      
      // Broadcast file change
      await this.broadcastPresence();
      
      // Emit file opened/closed events
      if (oldFile) {
        this.eventBus.emit(EVENTS.FILE_CLOSED, this.currentUserId, oldFile);
      }
      if (activity.filePath) {
        this.eventBus.emit(EVENTS.FILE_OPENED, this.currentUserId, activity.filePath);
      }
    }
    
    // Emit activity event
    this.eventBus.emit(EVENTS.USER_ACTIVITY, this.currentUserId, activity);
    
    this.log('Activity updated', activity);
  }

  /**
   * Get all active users
   */
  getActiveUsers(): ActiveUser[] {
    return Array.from(this.activeUsers.values());
  }

  /**
   * Get user activity
   */
  getUserActivity(userId: string): UserActivity | null {
    const user = this.activeUsers.get(userId);
    if (!user) {
      return null;
    }

    return {
      type: user.status === 'away' ? 'idle' : (user.currentFile ? 'editing' : 'viewing'),
      filePath: user.currentFile,
      timestamp: user.lastActivity
    };
  }

  /**
   * Get users viewing a file
   */
  getFileViewers(filePath: string): ActiveUser[] {
    const userIds = this.fileViewers.get(filePath);
    if (!userIds) {
      return [];
    }

    return Array.from(userIds)
      .map(userId => this.activeUsers.get(userId))
      .filter((user): user is ActiveUser => user !== undefined);
  }

  /**
   * Get users editing a file
   */
  getFileEditors(filePath: string): ActiveUser[] {
    return this.getFileViewers(filePath).filter(user => user.currentFile === filePath);
  }

  /**
   * Check if a file is being viewed by others
   */
  isFileBeingViewed(filePath: string): boolean {
    const viewers = this.fileViewers.get(filePath);
    return viewers !== undefined && viewers.size > 0;
  }

  /**
   * Get current user's presence state
   */
  getCurrentPresenceState(): PresenceState | null {
    if (!this.currentVaultId || !this.currentUserId) {
      return null;
    }

    return {
      userId: this.currentUserId,
      vaultId: this.currentVaultId,
      status: this.isIdle ? 'away' : 'active',
      currentFile: this.currentFile,
      lastActivity: this.lastActivity
    };
  }

  /**
   * Subscribe to user joined events
   */
  onUserJoined(callback: (user: ActiveUser) => void): () => void {
    return this.eventBus.on(EVENTS.USER_JOINED, callback);
  }

  /**
   * Subscribe to user left events
   */
  onUserLeft(callback: (userId: string) => void): () => void {
    return this.eventBus.on(EVENTS.USER_LEFT, callback);
  }

  /**
   * Subscribe to user activity events
   */
  onUserActivity(callback: (userId: string, activity: UserActivity) => void): () => void {
    return this.eventBus.on(EVENTS.USER_ACTIVITY, callback);
  }

  /**
   * Subscribe to file opened events
   */
  onFileOpened(callback: (userId: string, filePath: string) => void): () => void {
    return this.eventBus.on(EVENTS.FILE_OPENED, callback);
  }

  /**
   * Subscribe to file closed events
   */
  onFileClosed(callback: (userId: string, filePath: string) => void): () => void {
    return this.eventBus.on(EVENTS.FILE_CLOSED, callback);
  }

  /**
   * Cleanup
   */
  destroy(): void {
    void this.stopTracking();
    this.activityListeners.forEach(unsubscribe => unsubscribe());
    this.activityListeners = [];
  }

  // Private methods

  /**
   * Setup WebSocket event listeners
   */
  private setupWebSocketListeners(): void {
    // User joined
    this.wsManager.on(WS_EVENTS.USER_JOINED, (data: WsUserJoinedData) => {
      this.handleUserJoined(data);
    });

    // User left
    this.wsManager.on(WS_EVENTS.USER_LEFT, (data: WsUserLeftData) => {
      this.handleUserLeft(data);
    });

    // Presence update
    this.wsManager.on(WS_EVENTS.PRESENCE_UPDATE, (data: WsPresenceUpdateData) => {
      this.handlePresenceUpdate(data);
    });
  }

  /**
   * Handle user joined event
   */
  private handleUserJoined(data: WsUserJoinedData): void {
    const { user_id, user_name, user_avatar, vault_id } = data;
    
    // Only track users in the same vault
    if (vault_id !== this.currentVaultId) {
      return;
    }
    
    // Don't track self
    if (user_id === this.currentUserId) {
      return;
    }

    const user: ActiveUser = {
      userId: user_id,
      userName: user_name,
      userAvatar: user_avatar,
      status: 'active',
      currentFile: null,
      lastActivity: new Date()
    };

    this.activeUsers.set(user_id, user);
    void this.saveActiveUsersCache();

    this.log(`User joined: ${user_name}`);
    this.eventBus.emit(EVENTS.USER_JOINED, user);
  }

  /**
   * Handle user left event
   */
  private handleUserLeft(data: WsUserLeftData): void {
    const { user_id } = data;
    
    // Remove from active users
    this.activeUsers.delete(user_id);
    
    // Remove from file viewers
    this.fileViewers.forEach((viewers, filePath) => {
      viewers.delete(user_id);
      if (viewers.size === 0) {
        this.fileViewers.delete(filePath);
      }
    });

    void this.saveActiveUsersCache();
    void this.saveFileViewersCache();

    this.log(`User left: ${user_id}`);
    this.eventBus.emit(EVENTS.USER_LEFT, user_id);
  }

  /**
   * Handle presence update event
   */
  private handlePresenceUpdate(data: WsPresenceUpdateData): void {
    const { user_id, user_name, user_avatar, status, current_file, last_activity } = data;

    // Don't track self
    if (user_id === this.currentUserId) {
      return;
    }

    // If user is offline, remove them from active users
    if (status === 'offline') {
      this.handleUserLeft({ user_id });
      return;
    }

    // Map status to ActiveUser status type (only 'active' or 'away')
    const activeStatus: 'active' | 'away' = status === 'away' ? 'away' : 'active';

    // Get or create user
    let user = this.activeUsers.get(user_id);
    if (!user) {
      user = {
        userId: user_id,
        userName: user_name,
        userAvatar: user_avatar,
        status: activeStatus,
        currentFile: current_file || null,
        lastActivity: last_activity ? new Date(last_activity) : new Date()
      };
      this.activeUsers.set(user_id, user);
    } else {
      // Update existing user
      const oldFile = user.currentFile;
      user.status = activeStatus;
      user.currentFile = current_file || null;
      user.lastActivity = last_activity ? new Date(last_activity) : new Date();
      
      // Update file viewers
      if (oldFile !== current_file) {
        // Remove from old file
        if (oldFile) {
          const viewers = this.fileViewers.get(oldFile);
          if (viewers) {
            viewers.delete(user_id);
            if (viewers.size === 0) {
              this.fileViewers.delete(oldFile);
            }
          }
        }
        
        // Add to new file
        if (current_file) {
          if (!this.fileViewers.has(current_file)) {
            this.fileViewers.set(current_file, new Set());
          }
          this.fileViewers.get(current_file)!.add(user_id);
        }

        void this.saveFileViewersCache();
      }
    }

    void this.saveActiveUsersCache();
    
    this.log(`Presence updated for user: ${user_name}`, { status, current_file });
    
    // Emit activity event
    const activity: UserActivity = {
      type: status === 'away' ? 'idle' : (current_file ? 'editing' : 'viewing'),
      filePath: current_file || null,
      timestamp: user.lastActivity
    };
    this.eventBus.emit(EVENTS.USER_ACTIVITY, user_id, activity);
  }

  /**
   * Start heartbeat
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    this.heartbeatInterval = setInterval(() => {
      void this.broadcastPresence();
    }, PRESENCE_HEARTBEAT_MS);
    
    this.log('Heartbeat started');
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.log('Heartbeat stopped');
    }
  }

  /**
   * Start idle checking
   */
  private startIdleCheck(): void {
    this.stopIdleCheck();
    
    this.idleCheckInterval = setInterval(() => {
      const timeSinceActivity = Date.now() - this.lastActivity.getTime();
      
      if (timeSinceActivity >= IDLE_TIMEOUT_MS && !this.isIdle) {
        this.isIdle = true;
        void this.broadcastPresence('away');
        this.log('User is now idle');
      }
    }, 60000); // Check every minute
    
    this.log('Idle check started');
  }

  /**
   * Stop idle checking
   */
  private stopIdleCheck(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
      this.log('Idle check stopped');
    }
  }

  /**
   * Setup activity tracking
   */
  private setupActivityTracking(): void {
    // Track file open events
    const unsubscribeFileOpen = this.plugin.app.workspace.on('file-open', (file: TFile | null) => {
      if (file) {
        void this.updateActivity({
          type: 'editing',
          filePath: file.path,
          timestamp: new Date()
        });
      } else {
        void this.updateActivity({
          type: 'viewing',
          filePath: null,
          timestamp: new Date()
        });
      }
    });
    
    this.activityListeners.push(() => {
      this.plugin.app.workspace.offref(unsubscribeFileOpen);
    });
    
    // Track editor changes (typing)
    const unsubscribeEditorChange = this.plugin.app.workspace.on('editor-change', () => {
      this.lastActivity = new Date();
      if (this.isIdle) {
        this.isIdle = false;
        void this.broadcastPresence('active');
      }
    });
    
    this.activityListeners.push(() => {
      this.plugin.app.workspace.offref(unsubscribeEditorChange);
    });
    
    this.log('Activity tracking setup complete');
  }

  /**
   * Save active users to cache
   */
  private async saveActiveUsersCache(): Promise<void> {
    try {
      const usersObj: Record<string, ActiveUser> = {};
      this.activeUsers.forEach((user, userId) => {
        usersObj[userId] = user;
      });
      this.storage.setActiveUsers(usersObj);
      await this.storage.save();
    } catch (error) {
      this.log('Failed to save active users cache', error);
    }
  }

  /**
   * Save file viewers to cache
   */
  private async saveFileViewersCache(): Promise<void> {
    try {
      const viewersObj: Record<string, string[]> = {};
      this.fileViewers.forEach((viewers, filePath) => {
        viewersObj[filePath] = Array.from(viewers);
      });
      this.storage.setFileViewers(viewersObj);
      await this.storage.save();
    } catch (error) {
      this.log('Failed to save file viewers cache', error);
    }
  }

  /**
   * Log message (if debug mode enabled)
   */
  private log(message: string, data?: unknown): void {
    if (this.debugMode) {
      if (data !== undefined) {
        console.debug(`[PresenceService] ${message}`, data);
      } else {
        console.debug(`[PresenceService] ${message}`);
      }
    }
  }
}
