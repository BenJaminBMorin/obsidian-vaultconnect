import { Modal, App } from 'obsidian';
import { ErrorNotificationService } from '../services/ErrorNotificationService';
import { PluginError, ErrorType, ErrorSeverity } from '../utils/errors';

/**
 * Error Log Modal
 * Displays error logs with filtering and export capabilities
 */
export class ErrorLogModal extends Modal {
  private errorNotificationService: ErrorNotificationService;
  private currentFilter: ErrorType | 'all' = 'all';
  private currentSeverityFilter: ErrorSeverity | 'all' = 'all';

  constructor(app: App, errorNotificationService: ErrorNotificationService) {
    super(app);
    this.errorNotificationService = errorNotificationService;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vaultsync-error-log-modal');

    this.renderHeader();
    this.renderFilters();
    this.renderErrorList();
  }

  /**
   * Render modal header
   */
  private renderHeader(): void {
    const { contentEl } = this;

    const header = contentEl.createDiv('vaultsync-error-log-header');

    // Title
    const title = header.createDiv('vaultsync-error-log-title');
    title.textContent = 'Error log';

    // Actions
    const actions = header.createDiv('vaultsync-error-log-actions');

    // Export button
    const exportBtn = actions.createEl('button', {
      text: 'Export',
      cls: 'vaultsync-error-log-export-button'
    });
    exportBtn.addEventListener('click', () => this.exportLogs());

    // Clear button
    const clearBtn = actions.createEl('button', {
      text: 'Clear all',
      cls: 'vaultsync-error-log-clear-button'
    });
    clearBtn.addEventListener('click', () => this.clearLogs());
  }

  /**
   * Render filter controls
   */
  private renderFilters(): void {
    const { contentEl } = this;

    const filters = contentEl.createDiv('vaultsync-error-log-filters');

    // Type filters
    const typeFilters: ('all' | ErrorType)[] = ['all', ...Object.values(ErrorType)];
    typeFilters.forEach(type => {
      const button = filters.createEl('button', {
        text: type === 'all' ? 'All types' : this.formatErrorType(type),
        cls: 'vaultsync-error-log-filter-button'
      });

      if (type === this.currentFilter) {
        button.addClass('active');
      }

      button.addEventListener('click', () => {
        this.currentFilter = type;
        this.refresh();
      });
    });

    // Severity filters
    const severityFilters: ('all' | ErrorSeverity)[] = ['all', ...Object.values(ErrorSeverity)];
    severityFilters.forEach(severity => {
      const button = filters.createEl('button', {
        text: severity === 'all' ? 'All severities' : (severity as string).toUpperCase(),
        cls: 'vaultsync-error-log-filter-button'
      });

      if (severity === this.currentSeverityFilter) {
        button.addClass('active');
      }

      button.addEventListener('click', () => {
        this.currentSeverityFilter = severity;
        this.refresh();
      });
    });
  }

  /**
   * Render error list
   */
  private renderErrorList(): void {
    const { contentEl } = this;

    // Remove existing list if any
    const existingList = contentEl.querySelector('.vaultsync-error-log-list');
    if (existingList) {
      existingList.remove();
    }

    const listContainer = contentEl.createDiv('vaultsync-error-log-list');

    // Get filtered errors
    const errors = this.getFilteredErrors();

    if (errors.length === 0) {
      this.renderEmptyState(listContainer);
      return;
    }

    // Render each error
    errors.forEach(error => {
      this.renderErrorItem(listContainer, error);
    });
  }

  /**
   * Render empty state
   */
  private renderEmptyState(container: HTMLElement): void {
    const empty = container.createDiv('vaultsync-error-log-empty');
    const icon = empty.createDiv('vaultsync-error-log-empty-icon');
    icon.textContent = '✓';
    const text = empty.createDiv('vaultsync-error-log-empty-text');
    text.textContent = 'No errors logged';
  }

  /**
   * Render error item
   */
  private renderErrorItem(container: HTMLElement, error: PluginError): void {
    const item = container.createDiv('vaultsync-error-log-item');
    item.addClass(`severity-${error.severity}`);

    // Header
    const header = item.createDiv('vaultsync-error-log-item-header');
    const typeEl = header.createDiv('vaultsync-error-log-item-type');
    typeEl.textContent = this.formatErrorType(error.type);
    const timeEl = header.createDiv('vaultsync-error-log-item-time');
    timeEl.textContent = this.formatTime(error.timestamp);

    // Message
    const messageEl = item.createDiv('vaultsync-error-log-item-message');
    messageEl.textContent = error.message;

    // User message
    const userMessageEl = item.createDiv('vaultsync-error-log-item-user-message');
    userMessageEl.textContent = error.userMessage;

    // Details
    if (error.context) {
      const details = item.createDiv('vaultsync-error-log-item-details');
      details.textContent = JSON.stringify(error.context, null, 2);
    }

    // Badges
    const badges = item.createDiv('vaultsync-error-log-item-badges');
    
    badges.createSpan({
      text: error.severity,
      cls: 'vaultsync-error-log-badge'
    });

    if (error.recoverable) {
      badges.createSpan({
        text: 'recoverable',
        cls: 'vaultsync-error-log-badge recoverable'
      });
    }

    if (error.retryable) {
      badges.createSpan({
        text: 'retryable',
        cls: 'vaultsync-error-log-badge retryable'
      });
    }
  }

  /**
   * Get filtered errors
   */
  private getFilteredErrors(): PluginError[] {
    let errors = this.errorNotificationService.getErrorLogs();

    // Filter by type
    if (this.currentFilter !== 'all') {
      errors = errors.filter(e => e.type === this.currentFilter);
    }

    // Filter by severity
    if (this.currentSeverityFilter !== 'all') {
      errors = errors.filter(e => e.severity === this.currentSeverityFilter);
    }

    return errors;
  }

  /**
   * Format error type
   */
  private formatErrorType(type: string): string {
    return type
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Format time
   */
  private formatTime(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  }

  /**
   * Export logs
   */
  private exportLogs(): void {
    const logs = this.errorNotificationService.exportErrorLogs();
    
    // Create a blob and download
    const blob = new Blob([logs], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vaultsync-error-log-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);

    this.errorNotificationService.showSuccess('Error log exported');
  }

  /**
   * Clear logs
   */
  private clearLogs(): void {
    this.errorNotificationService.clearErrorLogs();
    this.refresh();
    this.errorNotificationService.showInfo('Error log cleared');
  }

  /**
   * Refresh the modal
   */
  private refresh(): void {
    this.onOpen();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
