import { App, Modal, Setting } from 'obsidian';
import { SyncLogService, SyncLogEntry, SyncLogType, SyncLogFilter } from '../services/SyncLogService';
import { showConfirmationModal } from './ConfirmationModal';

/**
 * Sync log modal
 * Displays sync activity log with filtering and search
 */
export class SyncLogModal extends Modal {
  private syncLogService: SyncLogService;
  private filter: SyncLogFilter = {};
  private logs: SyncLogEntry[] = [];

  constructor(app: App, syncLogService: SyncLogService) {
    super(app);
    this.syncLogService = syncLogService;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vaultsync-sync-log-modal');

    // Title
    contentEl.createEl('h2', { text: 'Sync log' });

    // Statistics section
    this.renderStatistics(contentEl);

    // Filter section
    this.renderFilters(contentEl);

    // Log entries
    this.renderLogs(contentEl);
  }

  /**
   * Render statistics
   */
  private renderStatistics(containerEl: HTMLElement): void {
    const statsContainer = containerEl.createDiv({ cls: 'sync-log-statistics' });
    
    const stats = this.syncLogService.getStatistics();

    // Create stats grid
    const statsGrid = statsContainer.createDiv({ cls: 'stats-grid' });

    // Total syncs
    this.createStatItem(statsGrid, 'Total syncs', stats.totalSyncs.toString());

    // Success rate
    const successRate = stats.totalSyncs > 0
      ? Math.round((stats.successfulSyncs / stats.totalSyncs) * 100)
      : 0;
    this.createStatItem(statsGrid, 'Success rate', `${successRate}%`);

    // Files uploaded
    this.createStatItem(statsGrid, 'Files uploaded', stats.filesUploaded.toString());

    // Files downloaded
    this.createStatItem(statsGrid, 'Files downloaded', stats.filesDownloaded.toString());

    // Conflicts
    this.createStatItem(statsGrid, 'Conflicts', stats.conflictsDetected.toString());

    // Average duration
    const avgDuration = stats.averageSyncDuration > 0
      ? `${(stats.averageSyncDuration / 1000).toFixed(1)}s`
      : 'N/A';
    this.createStatItem(statsGrid, 'Avg duration', avgDuration);

    // Last sync
    const lastSync = stats.lastSyncTime
      ? this.formatTimestamp(stats.lastSyncTime)
      : 'Never';
    this.createStatItem(statsGrid, 'Last sync', lastSync);
  }

  /**
   * Create stat item
   */
  private createStatItem(container: HTMLElement, label: string, value: string): void {
    const item = container.createDiv({ cls: 'stat-item' });
    item.createDiv({ cls: 'stat-label', text: label });
    item.createDiv({ cls: 'stat-value', text: value });
  }

  /**
   * Render filters
   */
  private renderFilters(containerEl: HTMLElement): void {
    const filterContainer = containerEl.createDiv({ cls: 'sync-log-filters' });

    // Search
    new Setting(filterContainer)
      .setName('Search')
      .setDesc('Search logs by message, file path, or error')
      .addText(text => {
        text
          .setPlaceholder('Search...')
          .setValue(this.filter.searchQuery || '')
          .onChange(value => {
            this.filter.searchQuery = value.trim() || undefined;
            this.refreshLogs();
          });
      });

    // Type filter
    new Setting(filterContainer)
      .setName('Type')
      .setDesc('Filter by log type')
      .addDropdown(dropdown => {
        dropdown
          .addOption('all', 'All types')
          .addOption(SyncLogType.SYNC_STARTED, 'Sync started')
          .addOption(SyncLogType.SYNC_COMPLETED, 'Sync completed')
          .addOption(SyncLogType.SYNC_ERROR, 'Sync error')
          .addOption(SyncLogType.FILE_UPLOADED, 'File uploaded')
          .addOption(SyncLogType.FILE_DOWNLOADED, 'File downloaded')
          .addOption(SyncLogType.FILE_DELETED, 'File deleted')
          .addOption(SyncLogType.CONFLICT_DETECTED, 'Conflict detected')
          .addOption(SyncLogType.CONFLICT_RESOLVED, 'Conflict resolved')
          .addOption(SyncLogType.CONNECTION_CHANGED, 'Connection changed')
          .addOption(SyncLogType.CONNECTION_ERROR, 'Connection error')
          .setValue('all')
          .onChange(value => {
            if (value === 'all') {
              this.filter.types = undefined;
            } else {
              this.filter.types = [value as SyncLogType];
            }
            this.refreshLogs();
          });
      });

    // Actions
    const actionsContainer = filterContainer.createDiv({ cls: 'sync-log-actions' });
    
    new Setting(actionsContainer)
      .addButton(button => {
        button
          .setButtonText('Clear filters')
          .onClick(() => {
            this.filter = {};
            this.onOpen(); // Refresh entire modal
          });
      })
      .addButton(button => {
        button
          .setButtonText('Export logs')
          .onClick(() => {
            this.exportLogs();
          });
      })
      .addButton(button => {
        button
          .setButtonText('Clear logs')
          .setWarning()
          .onClick(async () => {
            const confirmed = await showConfirmationModal(
              this.app,
              'Are you sure you want to clear all sync logs?',
              { title: 'Clear logs', confirmText: 'Clear', confirmClass: 'mod-warning' }
            );
            if (confirmed) {
              await this.syncLogService.clearLogs();
              this.onOpen(); // Refresh
            }
          });
      });
  }

  /**
   * Render logs
   */
  private renderLogs(containerEl: HTMLElement): void {
    const logsContainer = containerEl.createDiv({ cls: 'sync-log-entries' });

    // Get filtered logs
    this.logs = this.syncLogService.getFilteredLogs(this.filter);

    if (this.logs.length === 0) {
      logsContainer.createDiv({
        cls: 'sync-log-empty',
        text: 'No log entries found'
      });
      return;
    }

    // Show count
    logsContainer.createDiv({
      cls: 'sync-log-count',
      text: `Showing ${this.logs.length} log entries`
    });

    // Create log list
    const logList = logsContainer.createDiv({ cls: 'sync-log-list' });

    for (const log of this.logs) {
      this.renderLogEntry(logList, log);
    }
  }

  /**
   * Render log entry
   */
  private renderLogEntry(container: HTMLElement, log: SyncLogEntry): void {
    const entry = container.createDiv({ cls: `sync-log-entry log-type-${log.type}` });

    // Header
    const header = entry.createDiv({ cls: 'log-entry-header' });
    
    // Icon
    const icon = this.getLogIcon(log.type);
    header.createSpan({ cls: 'log-entry-icon', text: icon });

    // Timestamp
    header.createSpan({
      cls: 'log-entry-timestamp',
      text: this.formatTimestamp(log.timestamp)
    });

    // Type
    header.createSpan({
      cls: 'log-entry-type',
      text: this.formatLogType(log.type)
    });

    // Message
    entry.createDiv({
      cls: 'log-entry-message',
      text: log.message
    });

    // File path
    if (log.filePath) {
      entry.createDiv({
        cls: 'log-entry-filepath',
        text: `📄 ${log.filePath}`
      });
    }

    // Error
    if (log.error) {
      entry.createDiv({
        cls: 'log-entry-error',
        text: `❌ ${log.error}`
      });
    }

    // Details (collapsible)
    if (log.details) {
      const detailsToggle = entry.createDiv('log-entry-details-toggle');
      detailsToggle.setText('Show details ▼');

      const detailsContent = entry.createDiv('log-entry-details');
      detailsContent.addClass('vaultconnect-hidden');
      detailsContent.createEl('pre', {
        text: JSON.stringify(log.details, null, 2)
      });

      detailsToggle.onclick = () => {
        if (detailsContent.hasClass('vaultconnect-hidden')) {
          detailsContent.removeClass('vaultconnect-hidden');
          detailsToggle.setText('Hide details ▲');
        } else {
          detailsContent.addClass('vaultconnect-hidden');
          detailsToggle.setText('Show details ▼');
        }
      };
    }
  }

  /**
   * Get log icon
   */
  private getLogIcon(type: SyncLogType): string {
    switch (type) {
      case SyncLogType.SYNC_STARTED:
        return '🔄';
      case SyncLogType.SYNC_COMPLETED:
        return '✅';
      case SyncLogType.SYNC_ERROR:
        return '❌';
      case SyncLogType.FILE_UPLOADED:
        return '⬆️';
      case SyncLogType.FILE_DOWNLOADED:
        return '⬇️';
      case SyncLogType.FILE_DELETED:
        return '🗑️';
      case SyncLogType.CONFLICT_DETECTED:
        return '⚠️';
      case SyncLogType.CONFLICT_RESOLVED:
        return '✔️';
      case SyncLogType.CONNECTION_CHANGED:
        return '🔌';
      case SyncLogType.CONNECTION_ERROR:
        return '🔴';
      default:
        return '📝';
    }
  }

  /**
   * Format log type
   */
  private formatLogType(type: SyncLogType): string {
    return type
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Format timestamp
   */
  private formatTimestamp(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) {
      return 'just now';
    } else if (minutes < 60) {
      return `${minutes}m ago`;
    } else if (hours < 24) {
      return `${hours}h ago`;
    } else if (days < 7) {
      return `${days}d ago`;
    } else {
      return date.toLocaleString();
    }
  }

  /**
   * Refresh logs
   */
  private refreshLogs(): void {
    const logsContainer = this.contentEl.querySelector('.sync-log-entries');
    if (logsContainer) {
      logsContainer.remove();
      this.renderLogs(this.contentEl);
    }
  }

  /**
   * Export logs
   */
  private exportLogs(): void {
    const logs = this.syncLogService.exportLogs();
    const blob = new Blob([logs], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vaultsync-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
