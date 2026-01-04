import { Notice, Plugin } from 'obsidian';
import {
  VaultSyncError,
  PluginError,
  ErrorType,
  ErrorSeverity,
  ErrorLogger,
  ErrorClassifier,
  getUserMessage
} from '../utils/errors';
import { EventBus, EVENTS } from '../core/EventBus';

/**
 * Type extension for Notice with internal noticeEl property
 */
type NoticeWithElement = Notice & {
  noticeEl?: HTMLElement;
};

/**
 * Error event data for handlers
 */
interface ErrorData {
  message?: string;
  code?: string;
  path?: string;
  [key: string]: unknown;
}

/**
 * Conflict notification data
 */
interface ConflictData {
  path: string;
  conflictId: string;
}

/**
 * Error handler context
 */
interface ErrorContext {
  context?: Record<string, unknown>;
}

/**
 * Notification options
 */
export interface NotificationOptions {
  duration?: number;
  showDetails?: boolean;
  actionButton?: {
    text: string;
    callback: () => void;
  };
}

/**
 * Error notification configuration
 */
export interface ErrorNotificationConfig {
  showNotifications: boolean;
  showDetailsInConsole: boolean;
  notificationDuration: number;
  enableErrorReporting: boolean;
}

/**
 * Error Notification Service
 * Displays user-friendly error notifications and manages error reporting
 */
export class ErrorNotificationService {
  private plugin: Plugin;
  private eventBus: EventBus;
  private config: ErrorNotificationConfig;
  private notificationQueue: Array<{ error: VaultSyncError; options?: NotificationOptions }> = [];
  private isProcessingQueue = false;

  constructor(
    plugin: Plugin,
    eventBus: EventBus,
    config: ErrorNotificationConfig
  ) {
    this.plugin = plugin;
    this.eventBus = eventBus;
    this.config = config;

    this.setupEventHandlers();
  }

  /**
   * Setup event handlers for automatic error notifications
   */
  private setupEventHandlers(): void {
    // Listen for sync errors
    this.eventBus.on(EVENTS.SYNC_ERROR, (error: ErrorData | VaultSyncError) => {
      this.handleError(error, { context: { source: 'sync' } });
    });

    // Listen for auth errors
    this.eventBus.on(EVENTS.AUTH_ERROR, (error: ErrorData | VaultSyncError) => {
      this.handleError(error, { context: { source: 'auth' } });
    });

    // Listen for WebSocket errors
    this.eventBus.on(EVENTS.WEBSOCKET_ERROR, (error: ErrorData | VaultSyncError) => {
      this.handleError(error, { context: { source: 'websocket' } });
    });

    // Listen for conflict errors
    this.eventBus.on(EVENTS.CONFLICT_DETECTED, (data: ConflictData) => {
      this.showConflictNotification(data);
    });
  }

  /**
   * Handle an error
   */
  handleError(error: ErrorData | VaultSyncError | Error, context?: ErrorContext): void {
    // Classify and log the error
    const vaultSyncError = error instanceof VaultSyncError
      ? error
      : this.classifyError(error, context?.context);

    ErrorLogger.log(vaultSyncError);

    // Show notification if enabled
    if (this.config.showNotifications) {
      this.queueNotification(vaultSyncError);
    }

    // Log details to console if enabled
    if (this.config.showDetailsInConsole) {
      this.logErrorDetails(vaultSyncError);
    }

    // Report error if enabled
    if (this.config.enableErrorReporting) {
      this.reportError(vaultSyncError);
    }
  }

  /**
   * Classify a generic error
   */
  private classifyError(error: ErrorData | Error, context?: Record<string, unknown>): VaultSyncError {
    return ErrorClassifier.classify(error, context);
  }

  /**
   * Queue a notification
   */
  private queueNotification(error: VaultSyncError, options?: NotificationOptions): void {
    this.notificationQueue.push({ error, options });
    this.processNotificationQueue();
  }

  /**
   * Process notification queue
   */
  private async processNotificationQueue(): Promise<void> {
    if (this.isProcessingQueue || this.notificationQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.notificationQueue.length > 0) {
      const { error, options } = this.notificationQueue.shift()!;
      await this.showErrorNotification(error, options);
      
      // Small delay between notifications
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    this.isProcessingQueue = false;
  }

  /**
   * Show error notification
   */
  async showErrorNotification(
    error: VaultSyncError,
    options?: NotificationOptions
  ): Promise<void> {
    const duration = options?.duration ?? this.getNotificationDuration(error.severity);
    const message = this.formatNotificationMessage(error, options?.showDetails);

    // Create notice
    const notice = new Notice(message, duration);

    // Add action button if provided
    if (options?.actionButton) {
      const noticeWithEl = notice as NoticeWithElement;
      const noticeEl = noticeWithEl.noticeEl;
      if (noticeEl) {
        const button = noticeEl.createEl('button', {
          text: options.actionButton.text,
          cls: 'vaultsync-error-action-button'
        });
        button.addEventListener('click', () => {
          options.actionButton!.callback();
          notice.hide();
        });
      }
    }
  }

  /**
   * Show conflict notification
   */
  private showConflictNotification(data: { path: string; conflictId: string }): void {
    const message = `⚠️ Conflict detected in "${data.path}". Click to resolve.`;

    const notice = new Notice(message, 10000);
    const noticeWithEl = notice as NoticeWithElement;
    const noticeEl = noticeWithEl.noticeEl;

    if (noticeEl) {
      const button = noticeEl.createEl('button', {
        text: 'Resolve Conflict',
        cls: 'vaultsync-conflict-button'
      });
      button.addEventListener('click', () => {
        this.eventBus.emit(EVENTS.SHOW_CONFLICT_MODAL, data.conflictId);
        notice.hide();
      });
    }
  }

  /**
   * Show success notification
   */
  showSuccess(message: string, duration?: number): void {
    new Notice(`✓ ${message}`, duration ?? 3000);
  }

  /**
   * Show info notification
   */
  showInfo(message: string, duration?: number): void {
    new Notice(message, duration ?? 5000);
  }

  /**
   * Show warning notification
   */
  showWarning(message: string, duration?: number): void {
    new Notice(`⚠️ ${message}`, duration ?? 7000);
  }

  /**
   * Show error notification with custom message
   */
  showError(message: string, duration?: number): void {
    new Notice(`✕ ${message}`, duration ?? 10000);
  }

  /**
   * Format notification message
   */
  private formatNotificationMessage(error: VaultSyncError, showDetails?: boolean): string {
    let message = `✕ ${error.userMessage}`;

    if (showDetails && error.context) {
      const details = this.formatContextDetails(error.context);
      if (details) {
        message += `\n${details}`;
      }
    }

    // Add retry hint for retryable errors
    if (error.retryable) {
      message += '\n(Will retry automatically)';
    }

    return message;
  }

  /**
   * Format context details
   */
  private formatContextDetails(context: Record<string, unknown>): string {
    const details: string[] = [];

    if (context.path) {
      details.push(`File: ${context.path}`);
    }

    if (context.operation) {
      details.push(`Operation: ${context.operation}`);
    }

    if (context.source) {
      details.push(`Source: ${context.source}`);
    }

    return details.join(' | ');
  }

  /**
   * Get notification duration based on severity
   */
  private getNotificationDuration(severity: ErrorSeverity): number {
    switch (severity) {
      case ErrorSeverity.CRITICAL:
        return 15000; // 15 seconds
      case ErrorSeverity.HIGH:
        return 10000; // 10 seconds
      case ErrorSeverity.MEDIUM:
        return 7000; // 7 seconds
      case ErrorSeverity.LOW:
        return 5000; // 5 seconds
      default:
        return this.config.notificationDuration;
    }
  }

  /**
   * Log error details to console
   */
  private logErrorDetails(error: VaultSyncError): void {
    console.group(`🔴 VaultSync Error: ${error.type}`);
    console.error('Message:', error.message);
    console.error('User Message:', error.userMessage);
    console.error('Severity:', error.severity);
    console.error('Recoverable:', error.recoverable);
    console.error('Retryable:', error.retryable);
    console.error('Timestamp:', error.timestamp.toISOString());

    if (error.context) {
      console.error('Context:', error.context);
    }

    if (error.originalError) {
      console.error('Original Error:', error.originalError);
      if (error.originalError.stack) {
        console.error('Stack Trace:', error.originalError.stack);
      }
    }

    console.groupEnd();
  }

  /**
   * Report error (optional feature for telemetry)
   */
  private async reportError(error: VaultSyncError): Promise<void> {
    // This is a placeholder for optional error reporting
    // In a real implementation, this would send error data to a telemetry service
    // Only with explicit user consent

    try {
      const errorReport = {
        type: error.type,
        message: error.message,
        severity: error.severity,
        timestamp: error.timestamp.toISOString(),
        context: error.context,
        // Never include sensitive data like API keys or file contents
        version: this.plugin.manifest.version
      };

      // Log that we would report (but don't actually send anywhere)
      console.debug('Error report prepared (not sent):', errorReport);

      // In a real implementation with user consent:
      // import { requestUrl } from 'obsidian';
      // await requestUrl({
      //   url: 'https://telemetry.example.com/errors',
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify(errorReport)
      // });
    } catch (reportError) {
      console.error('Failed to report error:', reportError);
    }
  }

  /**
   * Show network error with retry action
   */
  showNetworkError(error: VaultSyncError, retryCallback: () => void): void {
    this.showErrorNotification(error, {
      actionButton: {
        text: 'Retry Now',
        callback: retryCallback
      }
    });
  }

  /**
   * Show auth error with login action
   */
  showAuthError(error: VaultSyncError, loginCallback: () => void): void {
    this.showErrorNotification(error, {
      actionButton: {
        text: 'Log In',
        callback: loginCallback
      }
    });
  }

  /**
   * Show sync error with details
   */
  showSyncError(error: VaultSyncError, filePath?: string): void {
    // Create a new error with updated context if needed
    if (filePath && !error.context?.path) {
      const updatedContext = { ...error.context, path: filePath };
      const updatedError = new VaultSyncError(
        error.type,
        error.message,
        error.userMessage,
        {
          recoverable: error.recoverable,
          retryable: error.retryable,
          severity: error.severity,
          context: updatedContext,
          originalError: error.originalError
        }
      );
      this.showErrorNotification(updatedError, {
        showDetails: true
      });
    } else {
      this.showErrorNotification(error, {
        showDetails: true
      });
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ErrorNotificationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get error logs
   */
  getErrorLogs(): PluginError[] {
    return ErrorLogger.getLogs();
  }

  /**
   * Get error logs by type
   */
  getErrorLogsByType(type: ErrorType): PluginError[] {
    return ErrorLogger.getLogsByType(type);
  }

  /**
   * Get error logs by severity
   */
  getErrorLogsBySeverity(severity: ErrorSeverity): PluginError[] {
    return ErrorLogger.getLogsBySeverity(severity);
  }

  /**
   * Clear error logs
   */
  clearErrorLogs(): void {
    ErrorLogger.clearLogs();
  }

  /**
   * Export error logs
   */
  exportErrorLogs(): string {
    const logs = ErrorLogger.getLogs();
    return JSON.stringify(logs, null, 2);
  }
}
