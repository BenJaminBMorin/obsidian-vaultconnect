import { ItemView, WorkspaceLeaf } from 'obsidian';
import { EventBus, EVENTS } from '../core/EventBus';
import { PresenceService } from '../services/PresenceService';
import { ActiveUser } from '../types';

export const ACTIVE_USERS_VIEW_TYPE = 'vaultsync-active-users';

/**
 * Active Users View
 * Displays a list of active collaborators in the vault
 */
export class ActiveUsersView extends ItemView {
  private eventBus: EventBus;
  private presenceService: PresenceService;
  private viewContainerEl: HTMLElement;
  private unsubscribers: (() => void)[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    eventBus: EventBus,
    presenceService: PresenceService
  ) {
    super(leaf);
    this.eventBus = eventBus;
    this.presenceService = presenceService;
    
    // Setup event listeners
    this.setupEventListeners();
  }

  getViewType(): string {
    return ACTIVE_USERS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Active Users';
  }

  getIcon(): string {
    return 'users';
  }

  async onOpen(): Promise<void> {
    this.viewContainerEl = this.contentEl;
    this.viewContainerEl.empty();
    this.viewContainerEl.addClass('vaultsync-active-users-view');
    
    this.render();
  }

  async onClose(): Promise<void> {
    this.viewContainerEl.empty();
    // Unsubscribe from all events
    this.unsubscribers.forEach(unsub => unsub());
    this.unsubscribers = [];
  }

  /**
   * Render the view
   */
  render(): void {
    this.viewContainerEl.empty();

    // Create header
    const header = this.viewContainerEl.createDiv('vaultconnect-users-header');
    header.createEl('h4', { text: 'Active Users' });

    // Get active users
    const activeUsers = this.presenceService.getActiveUsers();

    if (activeUsers.length === 0) {
      const emptyState = this.viewContainerEl.createDiv();
      emptyState.addClass('vaultconnect-empty');
      emptyState.createEl('p', { text: 'No active users' });
      const hint = emptyState.createEl('p', {
        text: 'Other users will appear here when they connect to the vault'
      });
      hint.addClass('vaultconnect-text-xs');
      hint.addClass('vaultconnect-mt-sm');
      return;
    }

    // Create user count badge
    const countBadge = header.createDiv('vaultconnect-count-badge');
    countBadge.textContent = `${activeUsers.length}`;

    // Create user list
    const userList = this.viewContainerEl.createDiv('vaultconnect-user-list');

    activeUsers.forEach((user) => {
      this.renderUser(userList, user);
    });
  }

  /**
   * Render a single user
   */
  private renderUser(container: HTMLElement, user: ActiveUser): void {
    const userItem = container.createDiv('vaultconnect-user-item');

    // User header (avatar + name + status)
    const userHeader = userItem.createDiv('vaultconnect-user-header');

    // Avatar or status indicator
    if (user.userAvatar) {
      const img = userHeader.createEl('img', {
        cls: 'vaultconnect-user-avatar',
        attr: { src: user.userAvatar }
      });
    } else {
      // Status indicator
      const statusIndicator = userHeader.createDiv('vaultconnect-status-indicator');
      statusIndicator.addClass(user.status === 'active' ? 'vaultconnect-status-indicator--active' : 'vaultconnect-status-indicator--away');
    }

    // User info
    const userInfo = userHeader.createDiv('vaultconnect-user-info');

    // User name
    const userName = userInfo.createDiv('vaultconnect-user-name');
    userName.textContent = user.userName;

    // Status badge
    const statusBadge = userHeader.createDiv('vaultconnect-status-badge');
    statusBadge.textContent = user.status === 'active' ? 'Active' : 'Away';
    statusBadge.addClass(user.status === 'active' ? 'vaultconnect-status-badge--active' : 'vaultconnect-status-badge--away');

    // Current file
    if (user.currentFile) {
      const currentFile = userItem.createDiv('vaultconnect-current-file');
      currentFile.addClass('vaultconnect-current-file--clickable');

      const fileIcon = currentFile.createSpan({ cls: 'vaultconnect-file-icon' });
      fileIcon.textContent = '📄';

      const fileName = currentFile.createSpan({ cls: 'vaultconnect-file-name' });
      fileName.textContent = user.currentFile;

      // Make file clickable
      currentFile.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openFile(user.currentFile!);
      });
    } else {
      const noFile = userItem.createDiv('vaultconnect-no-file');
      noFile.textContent = 'Not viewing any file';
    }

    // Last activity
    const lastActivity = userItem.createDiv('vaultconnect-last-activity');
    lastActivity.textContent = `Last seen: ${this.formatLastSeen(user.lastActivity)}`;

    // Click to show user details
    userItem.addEventListener('click', () => {
      this.showUserDetails(user);
    });
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen for user joined
    this.unsubscribers.push(
      this.presenceService.onUserJoined(() => {
        this.render();
      })
    );

    // Listen for user left
    this.unsubscribers.push(
      this.presenceService.onUserLeft(() => {
        this.render();
      })
    );

    // Listen for user activity
    this.unsubscribers.push(
      this.presenceService.onUserActivity(() => {
        this.render();
      })
    );

    // Listen for file opened/closed
    this.unsubscribers.push(
      this.presenceService.onFileOpened(() => {
        this.render();
      })
    );

    this.unsubscribers.push(
      this.presenceService.onFileClosed(() => {
        this.render();
      })
    );
  }

  /**
   * Show user details
   */
  private showUserDetails(user: ActiveUser): void {
    // Show a modal or tooltip with more user details
    const activity = this.presenceService.getUserActivity(user.userId);
    
    let details = `User: ${user.userName}\n`;
    details += `Status: ${user.status}\n`;
    if (user.currentFile) {
      details += `Current file: ${user.currentFile}\n`;
    }
    if (activity) {
      details += `Activity: ${activity.type}\n`;
    }
    details += `Last activity: ${this.formatLastSeen(user.lastActivity)}`;
    
    // For now, just log to console
    // In a full implementation, this would show a modal
    console.debug(details);
  }

  /**
   * Open file in editor
   */
  private async openFile(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file) {
      await this.app.workspace.openLinkText(filePath, '', false);
    }
  }

  /**
   * Format last seen time
   */
  private formatLastSeen(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (seconds < 60) {
      return 'Just now';
    } else if (minutes < 60) {
      return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    } else if (hours < 24) {
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else {
      return date.toLocaleDateString();
    }
  }
}
