import { App, Modal, Notice, Platform, Setting } from 'obsidian';
import { SyncLogService, SyncLogEntry, SyncLogType, SyncLogFilter } from '../services/SyncLogService';
import { showConfirmationModal } from './ConfirmationModal';

/**
 * Sync log modal — viewer for the SyncLogService entries.
 *
 * Designed to be useful on mobile (iPhone in particular) since that's where
 * sync issues are most visible and dev-tools access is hardest. On mobile:
 *   - Stats panel collapses behind a toggle so errors are above the fold.
 *   - Default filter is "errors only" when any errors exist; otherwise all.
 *   - Copy-to-clipboard buttons (errors / full log) use navigator.clipboard
 *     which works in the iOS WebView, unlike the Blob+anchor download which
 *     doesn't on iOS.
 */
export class SyncLogModal extends Modal {
  private syncLogService: SyncLogService;
  private filter: SyncLogFilter = {};
  private logs: SyncLogEntry[] = [];
  private statsCollapsed: boolean;
  private errorsOnly: boolean = false;
  private pluginVersion: string;

  constructor(app: App, syncLogService: SyncLogService, pluginVersion: string = '') {
    super(app);
    this.syncLogService = syncLogService;
    this.pluginVersion = pluginVersion;
    // Default to collapsed stats on mobile (limited screen real estate)
    this.statsCollapsed = Platform.isMobile;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vaultsync-sync-log-modal');
    if (Platform.isMobile) {
      contentEl.addClass('vaultsync-sync-log-modal-mobile');
    }

    // Header bar with title + quick-action copy buttons
    const header = contentEl.createDiv({ cls: 'sync-log-header' });
    const titleText = this.pluginVersion
      ? `Sync log — v${this.pluginVersion}`
      : 'Sync log';
    header.createEl('h2', { text: titleText });

    const headerActions = header.createDiv({ cls: 'sync-log-header-actions' });
    headerActions.createEl('button', {
      text: 'Copy errors',
      cls: 'mod-cta',
    }).onclick = () => this.copyToClipboard('errors');
    headerActions.createEl('button', {
      text: 'Copy all',
    }).onclick = () => this.copyToClipboard('all');

    // Default to errors-only when any errors are present — that's almost
    // always what brought the user here.
    const errorCount = this.syncLogService.getFilteredLogs({
      types: this.errorTypes(),
    }).length;
    if (errorCount > 0 && !this.errorsOnly) {
      this.errorsOnly = true;
    }

    this.renderStatistics(contentEl);
    this.renderFilters(contentEl);
    this.renderLogs(contentEl);
  }

  private errorTypes(): SyncLogType[] {
    return [SyncLogType.SYNC_ERROR, SyncLogType.CONNECTION_ERROR];
  }

  private renderStatistics(containerEl: HTMLElement): void {
    const statsContainer = containerEl.createDiv({ cls: 'sync-log-statistics' });

    // Toggle header (works as accordion on mobile)
    const toggleHeader = statsContainer.createDiv({ cls: 'sync-log-stats-toggle' });
    const arrow = this.statsCollapsed ? '▶' : '▼';
    toggleHeader.setText(`${arrow} Statistics`);
    toggleHeader.onclick = () => {
      this.statsCollapsed = !this.statsCollapsed;
      this.onOpen();
    };

    if (this.statsCollapsed) return;

    const stats = this.syncLogService.getStatistics();
    const grid = statsContainer.createDiv({ cls: 'stats-grid' });

    this.createStatItem(grid, 'Total syncs', stats.totalSyncs.toString());
    const successRate = stats.totalSyncs > 0
      ? Math.round((stats.successfulSyncs / stats.totalSyncs) * 100)
      : 0;
    this.createStatItem(grid, 'Success rate', `${successRate}%`);
    this.createStatItem(grid, 'Files uploaded', stats.filesUploaded.toString());
    this.createStatItem(grid, 'Files downloaded', stats.filesDownloaded.toString());
    this.createStatItem(grid, 'Conflicts', stats.conflictsDetected.toString());
    const avgDuration = stats.averageSyncDuration > 0
      ? `${(stats.averageSyncDuration / 1000).toFixed(1)}s`
      : 'N/A';
    this.createStatItem(grid, 'Avg duration', avgDuration);
    const lastSync = stats.lastSyncTime ? this.formatTimestamp(stats.lastSyncTime) : 'Never';
    this.createStatItem(grid, 'Last sync', lastSync);
  }

  private createStatItem(container: HTMLElement, label: string, value: string): void {
    const item = container.createDiv({ cls: 'stat-item' });
    item.createDiv({ cls: 'stat-label', text: label });
    item.createDiv({ cls: 'stat-value', text: value });
  }

  private renderFilters(containerEl: HTMLElement): void {
    const filterContainer = containerEl.createDiv({ cls: 'sync-log-filters' });

    // Errors-only quick toggle (most useful single button)
    const quickRow = filterContainer.createDiv({ cls: 'sync-log-quick-filters' });
    const errorsBtn = quickRow.createEl('button', {
      text: this.errorsOnly ? '✓ Errors only' : 'Errors only',
      cls: this.errorsOnly ? 'mod-cta' : '',
    });
    errorsBtn.onclick = () => {
      this.errorsOnly = !this.errorsOnly;
      this.filter.types = this.errorsOnly ? this.errorTypes() : undefined;
      this.onOpen();
    };

    const allBtn = quickRow.createEl('button', {
      text: !this.errorsOnly && !this.filter.searchQuery ? '✓ All' : 'All',
      cls: !this.errorsOnly && !this.filter.searchQuery ? 'mod-cta' : '',
    });
    allBtn.onclick = () => {
      this.errorsOnly = false;
      this.filter = {};
      this.onOpen();
    };

    // Search — kept simple so it works on mobile
    new Setting(filterContainer)
      .setName('Search')
      .addText(text => {
        text
          .setPlaceholder('Filter by message or path…')
          .setValue(this.filter.searchQuery || '')
          .onChange(value => {
            this.filter.searchQuery = value.trim() || undefined;
            this.refreshLogs();
          });
      });

    // Bottom action row
    const actions = filterContainer.createDiv({ cls: 'sync-log-actions' });
    actions.createEl('button', { text: 'Export logs (file)' }).onclick = () => this.exportLogs();
    const clearBtn = actions.createEl('button', { text: 'Clear logs', cls: 'mod-warning' });
    clearBtn.onclick = async () => {
      const confirmed = await showConfirmationModal(
        this.app,
        'Are you sure you want to clear all sync logs?',
        { title: 'Clear logs', confirmText: 'Clear', confirmClass: 'mod-warning' }
      );
      if (confirmed) {
        await this.syncLogService.clearLogs();
        this.onOpen();
      }
    };
  }

  private renderLogs(containerEl: HTMLElement): void {
    const logsContainer = containerEl.createDiv({ cls: 'sync-log-entries' });

    const activeFilter: SyncLogFilter = {
      ...this.filter,
      types: this.errorsOnly ? this.errorTypes() : this.filter.types,
    };
    this.logs = this.syncLogService.getFilteredLogs(activeFilter);

    if (this.logs.length === 0) {
      logsContainer.createDiv({
        cls: 'sync-log-empty',
        text: this.errorsOnly ? 'No errors recorded.' : 'No log entries found.',
      });
      return;
    }

    logsContainer.createDiv({
      cls: 'sync-log-count',
      text: `Showing ${this.logs.length} log entr${this.logs.length === 1 ? 'y' : 'ies'}`,
    });

    const logList = logsContainer.createDiv({ cls: 'sync-log-list' });
    for (const log of this.logs) {
      this.renderLogEntry(logList, log);
    }
  }

  private renderLogEntry(container: HTMLElement, log: SyncLogEntry): void {
    const entry = container.createDiv({ cls: `sync-log-entry log-type-${log.type}` });

    const header = entry.createDiv({ cls: 'log-entry-header' });
    header.createSpan({ cls: 'log-entry-icon', text: this.getLogIcon(log.type) });
    header.createSpan({ cls: 'log-entry-timestamp', text: this.formatTimestamp(log.timestamp) });
    header.createSpan({ cls: 'log-entry-type', text: this.formatLogType(log.type) });

    entry.createDiv({ cls: 'log-entry-message', text: log.message });

    if (log.filePath) {
      entry.createDiv({ cls: 'log-entry-filepath', text: `📄 ${log.filePath}` });
    }
    if (log.error) {
      entry.createDiv({ cls: 'log-entry-error', text: `❌ ${log.error}` });
    }

    if (log.details) {
      const detailsToggle = entry.createDiv('log-entry-details-toggle');
      detailsToggle.setText('Show details ▼');

      const detailsContent = entry.createDiv('log-entry-details');
      detailsContent.addClass('vaultconnect-hidden');
      detailsContent.createEl('pre', {
        text: JSON.stringify(log.details, null, 2),
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

  private getLogIcon(type: SyncLogType): string {
    switch (type) {
      case SyncLogType.SYNC_STARTED: return '🔄';
      case SyncLogType.SYNC_COMPLETED: return '✅';
      case SyncLogType.SYNC_ERROR: return '❌';
      case SyncLogType.FILE_UPLOADED: return '⬆️';
      case SyncLogType.FILE_DOWNLOADED: return '⬇️';
      case SyncLogType.FILE_DELETED: return '🗑️';
      case SyncLogType.CONFLICT_DETECTED: return '⚠️';
      case SyncLogType.CONFLICT_RESOLVED: return '✔️';
      case SyncLogType.CONNECTION_CHANGED: return '🔌';
      case SyncLogType.CONNECTION_ERROR: return '🔴';
      default: return '📝';
    }
  }

  private formatLogType(type: SyncLogType): string {
    return type
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private formatTimestamp(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleString();
  }

  private refreshLogs(): void {
    const logsContainer = this.contentEl.querySelector('.sync-log-entries');
    if (logsContainer) {
      logsContainer.remove();
      this.renderLogs(this.contentEl);
    }
  }

  /**
   * Format the active log set as a flat plain-text block suitable for pasting
   * into a bug report or chat. One entry per block, separated by blank lines.
   */
  private formatLogsAsText(logs: SyncLogEntry[]): string {
    const lines: string[] = [];
    const versionTag = this.pluginVersion ? ` (plugin v${this.pluginVersion})` : '';
    lines.push(`VaultConnect sync log${versionTag} — ${logs.length} entr${logs.length === 1 ? 'y' : 'ies'}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    for (const log of logs) {
      lines.push(`[${log.timestamp.toISOString()}] ${this.formatLogType(log.type)}`);
      lines.push(`  ${log.message}`);
      if (log.filePath) lines.push(`  path: ${log.filePath}`);
      if (log.error) lines.push(`  error: ${log.error}`);
      if (log.details) {
        const detail = JSON.stringify(log.details);
        // Trim very long detail lines so the clipboard payload stays usable
        lines.push(`  details: ${detail.length > 1000 ? detail.slice(0, 1000) + '… (truncated)' : detail}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * Copy the requested log subset (errors-only or all currently-filtered) to
   * the system clipboard. Uses navigator.clipboard.writeText which works in
   * the iOS WebView; falls back to a textarea+execCommand path if not.
   */
  private async copyToClipboard(scope: 'errors' | 'all'): Promise<void> {
    const logs = scope === 'errors'
      ? this.syncLogService.getFilteredLogs({ types: this.errorTypes() })
      : this.syncLogService.getFilteredLogs(this.filter);

    if (logs.length === 0) {
      new Notice(scope === 'errors' ? 'No errors to copy.' : 'No log entries to copy.');
      return;
    }

    const text = this.formatLogsAsText(logs);

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        new Notice(`Copied ${logs.length} ${scope === 'errors' ? 'error' : 'log'} entr${logs.length === 1 ? 'y' : 'ies'} to clipboard.`);
        return;
      }
    } catch (err) {
      console.warn('navigator.clipboard.writeText failed, falling back to textarea', err);
    }

    // Fallback for environments where navigator.clipboard isn't available
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
      new Notice(`Copied ${logs.length} entr${logs.length === 1 ? 'y' : 'ies'} to clipboard.`);
    } catch {
      new Notice('Copy failed. Try "Export logs" instead.');
    } finally {
      document.body.removeChild(textarea);
    }
  }

  /**
   * Export logs as a downloadable JSON file. Note: anchor-download doesn't
   * work on iOS WebView — desktop only. Mobile users should prefer the
   * "Copy" buttons above.
   */
  private exportLogs(): void {
    if (Platform.isMobile) {
      new Notice('On mobile, use "Copy all" or "Copy errors" instead — file download is desktop-only.');
      return;
    }
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
