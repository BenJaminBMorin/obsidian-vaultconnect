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
    const header = this.viewContainerEl.createDiv('active-users-header');
    const headerTitle = header.createEl('h4', { text: 'Active Users' });
    headerTitle.style.margin = '0';
    headerTitle.style.padding = '12px';
    headerTitle.style.borderBottom = '1px solid var(--background-modifier-border)';

    // Get active users
    const activeUsers = this.presenceService.getActiveUsers();

    if (activeUsers.length === 0) {
      const emptyState = this.viewContainerEl.createDiv('active-users-empty');
      emptyState.style.padding = '20px';
      emptyState.style.textAlign = 'center';
      emptyState.style.color = 'var(--text-muted)';
      emptyState.createEl('p', { text: 'No active users' });
      emptyState.createEl('p', { 
        text: 'Other users will appear here when they connect to the vault',
        attr: { style: 'font-size: 12px; margin-top: 8px;' }
      });
      return;
    }

    // Create user count badge
    const countBadge = header.createDiv('user-count-badge');
    countBadge.textContent = `${activeUsers.length}`;
    countBadge.style.position = 'absolute';
    countBadge.style.top = '12px';
    countBadge.style.right = '12px';
    countBadge.style.backgroundColor = 'var(--interactive-accent)';
    countBadge.style.color = 'var(--text-on-accent)';
    countBadge.style.borderRadius = '12px';
    countBadge.style.padding = '2px 8px';
    countBadge.style.fontSize = '11px';
    countBadge.style.fontWeight = 'bold';

    // Create user list
    const userList = this.viewContainerEl.createDiv('active-users-list');
    userList.style.padding = '8px';

    activeUsers.forEach((user) => {
      this.renderUser(userList, user);
    });
  }

  /**
   * Render a single user
   */
  private renderUser(container: HTMLElement, user: ActiveUser): void {
    const userItem = container.createDiv('active-user-item');
    userItem.style.padding = '12px';
    userItem.style.marginBottom = '8px';
    userItem.style.borderRadius = '6px';
    userItem.style.backgroundColor = 'var(--background-secondary)';
    userItem.style.cursor = 'pointer';
    userItem.style.transition = 'background-color 0.2s';

    // Hover effect
    userItem.addEventListener('mouseenter', () => {
      userItem.style.backgroundColor = 'var(--background-modifier-hover)';
    });
    userItem.addEventListener('mouseleave', () => {
      userItem.style.backgroundColor = 'var(--background-secondary)';
    });

    // User header (avatar + name + status)
    const userHeader = userItem.createDiv('user-header');
    userHeader.style.display = 'flex';
    userHeader.style.alignItems = 'center';
    userHeader.style.marginBottom = '8px';

    // Avatar or status indicator
    const avatar = userHeader.createDiv('user-avatar');
    if (user.userAvatar) {
      const img = avatar.createEl('img', { attr: { src: user.userAvatar } });
      img.style.width = '32px';
      img.style.height = '32px';
      img.style.borderRadius = '50%';
      img.style.marginRight = '12px';
    } else {
      // Status indicator
      const statusIndicator = avatar.createDiv('user-status-indicator');
      statusIndicator.style.backgroundColor = user.status === 'active' ? 'var(--color-green)' : 'var(--text-muted)';
      statusIndicator.style.width = '12px';
      statusIndicator.style.height = '12px';
      statusIndicator.style.borderRadius = '50%';
      statusIndicator.style.marginRight = '12px';
      statusIndicator.style.flexShrink = '0';
    }

    // User info
    const userInfo = userHeader.createDiv('user-info');
    userInfo.style.flex = '1';
    userInfo.style.minWidth = '0';

    // User name
    const userName = userInfo.createDiv('user-name');
    userName.textContent = user.userName;
    userName.style.fontWeight = '600';
    userName.style.color = 'var(--text-normal)';
    userName.style.overflow = 'hidden';
    userName.style.textOverflow = 'ellipsis';
    userName.style.whiteSpace = 'nowrap';

    // Status badge
    const statusBadge = userHeader.createDiv('user-status-badge');
    statusBadge.textContent = user.status === 'active' ? 'Active' : 'Away';
    statusBadge.style.fontSize = '10px';
    statusBadge.style.padding = '2px 6px';
    statusBadge.style.borderRadius = '4px';
    statusBadge.style.backgroundColor = user.status === 'active' ? 'var(--color-green)' : 'var(--background-modifier-border)';
    statusBadge.style.color = user.status === 'active' ? 'white' : 'var(--text-muted)';
    statusBadge.style.fontWeight = '600';

    // Current file
    if (user.currentFile) {
      const currentFile = userItem.createDiv('user-current-file');
      currentFile.style.fontSize = '12px';
      currentFile.style.color = 'var(--text-muted)';
      currentFile.style.marginBottom = '4px';
      currentFile.style.display = 'flex';
      currentFile.style.alignItems = 'center';
      currentFile.style.gap = '6px';

      const fileIcon = currentFile.createSpan();
      fileIcon.textContent = '📄';
      fileIcon.style.fontSize = '14px';

      const fileName = currentFile.createSpan();
      fileName.textContent = user.currentFile;
      fileName.style.overflow = 'hidden';
      fileName.style.textOverflow = 'ellipsis';
      fileName.style.whiteSpace = 'nowrap';
      fileName.style.flex = '1';

      // Make file clickable
      currentFile.style.cursor = 'pointer';
      currentFile.style.textDecoration = 'underline';
      currentFile.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openFile(user.currentFile!);
      });
    } else {
      const noFile = userItem.createDiv('user-no-file');
      noFile.textContent = 'Not viewing any file';
      noFile.style.fontSize = '12px';
      noFile.style.color = 'var(--text-faint)';
      noFile.style.fontStyle = 'italic';
      noFile.style.marginBottom = '4px';
    }

    // Last activity
    const lastActivity = userItem.createDiv('user-last-activity');
    lastActivity.textContent = `Last seen: ${this.formatLastSeen(user.lastActivity)}`;
    lastActivity.style.fontSize = '11px';
    lastActivity.style.color = 'var(--text-faint)';

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
