import { ItemView, WorkspaceLeaf } from 'obsidian';
import { EventBus } from '../core/EventBus';
import { CollaborationMetadataService, ActivityEntry } from '../services/CollaborationMetadataService';

export const RECENT_ACTIVITY_VIEW_TYPE = 'vaultsync-recent-activity';

/**
 * Recent Activity View
 * Displays recent collaboration activity in the vault
 */
export class RecentActivityView extends ItemView {
  private eventBus: EventBus;
  private metadataService: CollaborationMetadataService;
  private viewContainerEl: HTMLElement;
  private timeFilter: number = 24; // hours

  constructor(
    leaf: WorkspaceLeaf,
    eventBus: EventBus,
    metadataService: CollaborationMetadataService
  ) {
    super(leaf);
    this.eventBus = eventBus;
    this.metadataService = metadataService;

    // Setup event listeners
    this.setupEventListeners();
  }

  getViewType(): string {
    return RECENT_ACTIVITY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Recent activity';
  }

  getIcon(): string {
    return 'clock';
  }

  onOpen(): Promise<void> {
    this.viewContainerEl = this.contentEl;
    this.viewContainerEl.empty();
    this.viewContainerEl.addClass('vaultsync-recent-activity-view');

    this.render();
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    this.viewContainerEl.empty();
    return Promise.resolve();
  }

  /**
   * Render the view
   */
  render(): void {
    this.viewContainerEl.empty();

    // Create header
    const header = this.viewContainerEl.createDiv('vaultconnect-activity-header');

    header.createEl('h4', { text: 'Recent activity' });

    // Time filter dropdown
    const filterContainer = header.createDiv('activity-filter');
    filterContainer.createSpan({
      text: 'Last ',
      cls: 'vaultconnect-filter-label'
    });

    const filterSelect = filterContainer.createEl('select', {
      cls: 'vaultconnect-filter-select'
    });

    const options = [
      { value: 1, label: '1 hour' },
      { value: 6, label: '6 hours' },
      { value: 24, label: '24 hours' },
      { value: 168, label: '7 days' }
    ];

    options.forEach(opt => {
      const option = filterSelect.createEl('option', {
        text: opt.label,
        value: String(opt.value)
      });
      if (opt.value === this.timeFilter) {
        option.selected = true;
      }
    });

    filterSelect.addEventListener('change', () => {
      this.timeFilter = parseInt(filterSelect.value);
      this.render();
    });

    // Get recent activity
    const activities = this.metadataService.getRecentActivity(this.timeFilter);

    if (activities.length === 0) {
      const emptyState = this.viewContainerEl.createDiv('vaultconnect-empty-state');
      emptyState.createEl('p', { text: 'No recent activity' });
      return;
    }

    // Create activity list
    const activityList = this.viewContainerEl.createDiv('vaultconnect-activity-list');

    // Group activities by date
    const groupedActivities = this.groupActivitiesByDate(activities);

    groupedActivities.forEach((entries, dateLabel) => {
      // Date header
      const dateHeader = activityList.createDiv('vaultconnect-date-header');
      dateHeader.textContent = dateLabel;

      // Activity entries
      entries.forEach(entry => {
        this.renderActivityEntry(activityList, entry);
      });
    });
  }

  /**
   * Render a single activity entry
   */
  private renderActivityEntry(container: HTMLElement, entry: ActivityEntry): void {
    const entryEl = container.createDiv('vaultconnect-activity-entry');

    // Activity icon
    const icon = this.getActivityIcon(entry.action);
    const iconEl = entryEl.createSpan({ cls: 'vaultconnect-activity-icon' });
    iconEl.textContent = icon;

    // Activity text
    const textEl = entryEl.createSpan({ cls: 'vaultconnect-activity-text' });

    const userName = textEl.createEl('strong', { cls: 'vaultconnect-activity-user' });
    userName.textContent = entry.userName;

    const action = textEl.createSpan();
    action.textContent = ` ${this.getActionText(entry.action)} `;

    const fileName = textEl.createEl('span', { cls: 'vaultconnect-activity-file' });
    fileName.textContent = entry.filePath;

    // Timestamp
    const timestamp = entryEl.createDiv('vaultconnect-activity-timestamp');
    timestamp.textContent = this.formatTime(entry.timestamp);

    // Click to open file
    entryEl.addEventListener('click', () => {
      void this.openFile(entry.filePath);
    });
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen for new activity
    this.eventBus.on('collab:activity', () => {
      this.render();
    });
  }

  /**
   * Group activities by date
   */
  private groupActivitiesByDate(activities: ActivityEntry[]): Map<string, ActivityEntry[]> {
    const groups = new Map<string, ActivityEntry[]>();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    activities.forEach(entry => {
      const entryDate = new Date(entry.timestamp);
      const entryDay = new Date(entryDate.getFullYear(), entryDate.getMonth(), entryDate.getDate());

      let label: string;
      if (entryDay.getTime() === today.getTime()) {
        label = 'Today';
      } else if (entryDay.getTime() === yesterday.getTime()) {
        label = 'Yesterday';
      } else {
        label = entryDay.toLocaleDateString();
      }

      if (!groups.has(label)) {
        groups.set(label, []);
      }
      groups.get(label)!.push(entry);
    });

    return groups;
  }

  /**
   * Get activity icon
   */
  private getActivityIcon(action: string): string {
    switch (action) {
      case 'opened':
        return '📂';
      case 'closed':
        return '📁';
      case 'modified':
        return '✏️';
      default:
        return '📄';
    }
  }

  /**
   * Get action text
   */
  private getActionText(action: string): string {
    switch (action) {
      case 'opened':
        return 'opened';
      case 'closed':
        return 'closed';
      case 'modified':
        return 'modified';
      default:
        return action;
    }
  }

  /**
   * Format time
   */
  private formatTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (seconds < 60) {
      return 'just now';
    } else if (minutes < 60) {
      return `${minutes}m ago`;
    } else if (hours < 24) {
      return `${hours}h ago`;
    } else {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
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
}
