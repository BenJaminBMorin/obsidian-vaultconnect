import { Notice, Plugin } from 'obsidian';
import { EventBus } from '../core/EventBus';
import { PresenceService } from './PresenceService';
import { ActiveUser } from '../types';
import { PluginSettings } from '../types';

/**
 * Notification Manager
 * Handles collaboration notifications with throttling
 */
export class NotificationManager {
  private plugin: Plugin;
  private eventBus: EventBus;
  private presenceService: PresenceService;
  private settings: PluginSettings;
  
  // Notification throttling
  private lastNotificationTime: Map<string, number> = new Map();
  private throttleMs: number = 5000; // 5 seconds between similar notifications
  
  // Notification queue for batching
  private notificationQueue: Map<string, string[]> = new Map();
  private queueTimeout: NodeJS.Timeout | null = null;
  private queueDelayMs: number = 2000; // 2 seconds to batch notifications
  
  private unsubscribers: (() => void)[] = [];

  constructor(
    plugin: Plugin,
    eventBus: EventBus,
    presenceService: PresenceService,
    settings: PluginSettings
  ) {
    this.plugin = plugin;
    this.eventBus = eventBus;
    this.presenceService = presenceService;
    this.settings = settings;
  }

  /**
   * Initialize notification manager
   */
  initialize(): void {
    this.setupEventListeners();
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // User joined
    this.unsubscribers.push(
      this.presenceService.onUserJoined((user: ActiveUser) => {
        if (this.settings.notifyOnCollaboratorJoin) {
          this.notifyUserJoined(user);
        }
      })
    );

    // User left
    this.unsubscribers.push(
      this.presenceService.onUserLeft((userId: string) => {
        if (this.settings.notifyOnCollaboratorJoin) {
          this.notifyUserLeft(userId);
        }
      })
    );

    // File opened
    this.unsubscribers.push(
      this.presenceService.onFileOpened((userId: string, filePath: string) => {
        if (this.settings.notifyOnCollaboratorJoin) {
          this.notifyFileOpened(userId, filePath);
        }
      })
    );

    // File closed
    this.unsubscribers.push(
      this.presenceService.onFileClosed((userId: string, filePath: string) => {
        if (this.settings.notifyOnCollaboratorJoin) {
          this.notifyFileClosed(userId, filePath);
        }
      })
    );
  }

  /**
   * Notify when user joins
   */
  private notifyUserJoined(user: ActiveUser): void {
    const key = `user-joined-${user.userId}`;
    
    if (this.shouldThrottle(key)) {
      return;
    }

    this.queueNotification('user-joined', `${user.userName} joined the vault`);
    this.updateThrottle(key);
  }

  /**
   * Notify when user leaves
   */
  private notifyUserLeft(userId: string): void {
    const key = `user-left-${userId}`;
    
    if (this.shouldThrottle(key)) {
      return;
    }

    // Try to get user name from active users (might be gone already)
    const activeUsers = this.presenceService.getActiveUsers();
    const user = activeUsers.find(u => u.userId === userId);
    const userName = user ? user.userName : 'A user';

    this.queueNotification('user-left', `${userName} left the vault`);
    this.updateThrottle(key);
  }

  /**
   * Notify when user opens a file
   */
  private notifyFileOpened(userId: string, filePath: string): void {
    const key = `file-opened-${userId}-${filePath}`;
    
    if (this.shouldThrottle(key)) {
      return;
    }

    const activeUsers = this.presenceService.getActiveUsers();
    const user = activeUsers.find(u => u.userId === userId);
    
    if (!user) {
      return;
    }

    // Only notify if it's a file the current user might care about
    // (e.g., currently viewing or recently edited)
    const currentFile = this.plugin.app.workspace.getActiveFile();
    if (currentFile && currentFile.path === filePath) {
      this.queueNotification('file-opened', `${user.userName} is now editing ${filePath}`);
      this.updateThrottle(key);
    }
  }

  /**
   * Notify when user closes a file
   */
  private notifyFileClosed(userId: string, filePath: string): void {
    const key = `file-closed-${userId}-${filePath}`;
    
    if (this.shouldThrottle(key)) {
      return;
    }

    const activeUsers = this.presenceService.getActiveUsers();
    const user = activeUsers.find(u => u.userId === userId);
    
    if (!user) {
      return;
    }

    // Only notify if it's a file the current user might care about
    const currentFile = this.plugin.app.workspace.getActiveFile();
    if (currentFile && currentFile.path === filePath) {
      this.queueNotification('file-closed', `${user.userName} stopped editing ${filePath}`);
      this.updateThrottle(key);
    }
  }

  /**
   * Queue a notification for batching
   */
  private queueNotification(type: string, message: string): void {
    if (!this.notificationQueue.has(type)) {
      this.notificationQueue.set(type, []);
    }
    
    this.notificationQueue.get(type)!.push(message);
    
    // Clear existing timeout
    if (this.queueTimeout) {
      clearTimeout(this.queueTimeout);
    }
    
    // Set new timeout to flush queue
    this.queueTimeout = setTimeout(() => {
      this.flushNotificationQueue();
    }, this.queueDelayMs);
  }

  /**
   * Flush notification queue
   */
  private flushNotificationQueue(): void {
    this.notificationQueue.forEach((messages, type) => {
      if (messages.length === 0) {
        return;
      }

      if (messages.length === 1) {
        // Single notification
        new Notice(messages[0], 5000);
      } else {
        // Batch notification
        const summary = this.createBatchSummary(type, messages);
        new Notice(summary, 7000);
      }
    });
    
    // Clear queue
    this.notificationQueue.clear();
    this.queueTimeout = null;
  }

  /**
   * Create batch summary
   */
  private createBatchSummary(type: string, messages: string[]): string {
    switch (type) {
      case 'user-joined':
        if (messages.length === 2) {
          return `${messages[0]} and ${messages[1]}`;
        }
        return `${messages.length} users joined the vault`;
      
      case 'user-left':
        if (messages.length === 2) {
          return `${messages[0]} and ${messages[1]}`;
        }
        return `${messages.length} users left the vault`;
      
      case 'file-opened':
        return `${messages.length} users started editing files`;
      
      case 'file-closed':
        return `${messages.length} users stopped editing files`;
      
      default:
        return messages.join(', ');
    }
  }

  /**
   * Check if notification should be throttled
   */
  private shouldThrottle(key: string): boolean {
    const lastTime = this.lastNotificationTime.get(key);
    if (!lastTime) {
      return false;
    }
    
    const elapsed = Date.now() - lastTime;
    return elapsed < this.throttleMs;
  }

  /**
   * Update throttle timestamp
   */
  private updateThrottle(key: string): void {
    this.lastNotificationTime.set(key, Date.now());
  }

  /**
   * Show a custom notification
   */
  showNotification(message: string, duration: number = 5000): void {
    new Notice(message, duration);
  }

  /**
   * Show an error notification
   */
  showError(message: string, duration: number = 7000): void {
    new Notice(`❌ ${message}`, duration);
  }

  /**
   * Show a success notification
   */
  showSuccess(message: string, duration: number = 5000): void {
    new Notice(`✅ ${message}`, duration);
  }

  /**
   * Show a warning notification
   */
  showWarning(message: string, duration: number = 6000): void {
    new Notice(`⚠️ ${message}`, duration);
  }

  /**
   * Update settings
   */
  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  /**
   * Clear throttle cache
   */
  clearThrottle(): void {
    this.lastNotificationTime.clear();
  }

  /**
   * Cleanup
   */
  destroy(): void {
    // Flush any pending notifications
    if (this.queueTimeout) {
      clearTimeout(this.queueTimeout);
      this.flushNotificationQueue();
    }
    
    // Unsubscribe from events
    this.unsubscribers.forEach(unsub => unsub());
    this.unsubscribers = [];
    
    // Clear caches
    this.lastNotificationTime.clear();
    this.notificationQueue.clear();
  }
}
