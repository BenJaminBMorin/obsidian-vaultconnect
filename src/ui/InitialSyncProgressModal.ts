import { App, Modal } from 'obsidian';
import { ProgressInfo } from '../types/initial-sync.types';

/**
 * Initial Sync Progress Modal
 * 
 * Displays real-time progress during initial sync operations.
 * Shows current operation, file being processed, progress bar, and estimated time.
 */
export class InitialSyncProgressModal extends Modal {
  private onCancel: () => void;
  private contentContainer: HTMLElement | null = null;
  private operationLabel: HTMLElement | null = null;
  private currentFileLabel: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private progressBarFill: HTMLElement | null = null;
  private progressPercentage: HTMLElement | null = null;
  private fileCountLabel: HTMLElement | null = null;
  private estimatedTimeLabel: HTMLElement | null = null;
  private cancelButton: HTMLButtonElement | null = null;
  private closeButton: HTMLButtonElement | null = null;
  private isComplete: boolean = false;
  private isError: boolean = false;

  constructor(app: App, onCancel: () => void) {
    super(app);
    this.onCancel = onCancel;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('initial-sync-progress-modal');

    // Header
    contentEl.createEl('h2', { text: 'Syncing Files...' });

    // Content container
    this.contentContainer = contentEl.createDiv('progress-content');
    this.contentContainer.addClass('vaultconnect-min-h-200');
    this.contentContainer.addClass('vaultconnect-flex');
    this.contentContainer.addClass('vaultconnect-flex-col');
    this.contentContainer.addClass('vaultconnect-gap-md');

    // Operation label
    this.operationLabel = this.contentContainer.createDiv('operation-label');
    this.operationLabel.addClass('vaultconnect-font-medium');
    this.operationLabel.addClass('vaultconnect-text-normal');
    this.operationLabel.textContent = 'Preparing...';

    // Current file label
    this.currentFileLabel = this.contentContainer.createDiv('current-file-label');
    this.currentFileLabel.addClass('vaultconnect-text-sm');
    this.currentFileLabel.addClass('vaultconnect-text-muted');
    this.currentFileLabel.addClass('vaultconnect-text-ellipsis');
    this.currentFileLabel.textContent = '';

    // Progress bar container
    const progressBarContainer = this.contentContainer.createDiv('progress-bar-container');
    progressBarContainer.addClass('vaultconnect-progress-bar');
    progressBarContainer.addClass('vaultconnect-relative');
    progressBarContainer.addClass('vaultconnect-w-full');
    progressBarContainer.addClass('vaultconnect-h-30');
    progressBarContainer.addClass('vaultconnect-rounded-md');
    progressBarContainer.addClass('vaultconnect-overflow-hidden');

    // Progress bar fill
    this.progressBarFill = progressBarContainer.createDiv('progress-bar-fill');
    this.progressBarFill.addClass('vaultconnect-progress-bar-fill');
    this.progressBarFill.addClass('vaultconnect-h-full');

    // Progress percentage overlay
    this.progressPercentage = progressBarContainer.createDiv('progress-percentage');
    this.progressPercentage.addClass('vaultconnect-progress-percentage');
    this.progressPercentage.addClass('vaultconnect-text-sm');
    this.progressPercentage.addClass('vaultconnect-font-bold');
    this.progressPercentage.textContent = '0%';

    // File count label
    this.fileCountLabel = this.contentContainer.createDiv('file-count-label');
    this.fileCountLabel.addClass('vaultconnect-text-sm');
    this.fileCountLabel.addClass('vaultconnect-text-muted');
    this.fileCountLabel.addClass('vaultconnect-text-center');
    this.fileCountLabel.textContent = '0 of 0 files completed';

    // Estimated time label
    this.estimatedTimeLabel = this.contentContainer.createDiv('estimated-time-label');
    this.estimatedTimeLabel.addClass('vaultconnect-text-sm');
    this.estimatedTimeLabel.addClass('vaultconnect-text-muted');
    this.estimatedTimeLabel.addClass('vaultconnect-text-center');
    this.estimatedTimeLabel.textContent = '';

    // Button container
    const buttonContainer = contentEl.createDiv('modal-button-container');
    buttonContainer.addClass('vaultconnect-mt-lg');
    buttonContainer.addClass('vaultconnect-text-right');

    // Cancel button (shown during operation)
    this.cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
    this.cancelButton.addEventListener('click', () => {
      this.onCancel();
      this.cancelButton!.disabled = true;
      this.cancelButton!.textContent = 'Cancelling...';
    });

    // Close button (shown after completion or error, initially hidden)
    this.closeButton = buttonContainer.createEl('button', { text: 'Close' });
    this.closeButton.addClass('vaultconnect-hidden');
    this.closeButton.addEventListener('click', () => {
      this.close();
    });
  }

  /**
   * Update progress display with current operation info
   * 
   * @param info - Progress information
   */
  updateProgress(info: ProgressInfo): void {
    if (this.isComplete || this.isError) {
      return; // Don't update if already complete or errored
    }

    // Update operation label
    if (this.operationLabel) {
      const operationText = this.getOperationText(info.operation);
      this.operationLabel.textContent = operationText;
    }

    // Update current file label
    if (this.currentFileLabel && info.currentFile) {
      this.currentFileLabel.textContent = info.currentFile;
      this.currentFileLabel.title = info.currentFile; // Show full path on hover
    }

    // Update progress bar
    if (this.progressBarFill) {
      const percentage = Math.min(100, Math.max(0, info.percentage));
      this.progressBarFill.style.width = `${percentage}%`;
    }

    // Update progress percentage
    if (this.progressPercentage) {
      this.progressPercentage.textContent = `${Math.round(info.percentage)}%`;
    }

    // Update file count
    if (this.fileCountLabel) {
      this.fileCountLabel.textContent = `${info.completed} of ${info.total} files completed`;
    }

    // Update estimated time remaining
    if (this.estimatedTimeLabel && info.estimatedTimeRemaining !== undefined) {
      const timeText = this.formatTimeRemaining(info.estimatedTimeRemaining);
      this.estimatedTimeLabel.textContent = `Estimated time remaining: ${timeText}`;
    } else if (this.estimatedTimeLabel) {
      this.estimatedTimeLabel.textContent = '';
    }
  }

  /**
   * Show completion state with success message
   * 
   * @param summary - Summary of the completed operation
   */
  showComplete(summary: string): void {
    this.isComplete = true;

    // Update header
    const header = this.contentEl.querySelector('h2');
    if (header) {
      header.textContent = '✓ Sync Complete';
      header.addClass('vaultconnect-text-success');
    }

    // Update operation label
    if (this.operationLabel) {
      this.operationLabel.textContent = summary;
      this.operationLabel.addClass('vaultconnect-text-success');
    }

    // Hide current file label
    if (this.currentFileLabel) {
      this.currentFileLabel.addClass('vaultconnect-hidden');
    }

    // Set progress bar to 100% and change color
    if (this.progressBarFill) {
      this.progressBarFill.style.width = '100%';
      this.progressBarFill.addClass('vaultconnect-bg-success');
    }

    // Update progress percentage
    if (this.progressPercentage) {
      this.progressPercentage.textContent = '100%';
    }

    // Hide estimated time
    if (this.estimatedTimeLabel) {
      this.estimatedTimeLabel.addClass('vaultconnect-hidden');
    }

    // Hide cancel button, show close button
    if (this.cancelButton) {
      this.cancelButton.addClass('vaultconnect-hidden');
    }
    if (this.closeButton) {
      this.closeButton.removeClass('vaultconnect-hidden');
      this.closeButton.addClass('mod-cta');
    }
  }

  /**
   * Show error state with error message
   * 
   * @param error - Error message to display
   */
  showError(error: string): void {
    this.isError = true;

    // Update header
    const header = this.contentEl.querySelector('h2');
    if (header) {
      header.textContent = '✗ Sync Failed';
      header.addClass('vaultconnect-text-error');
    }

    // Update operation label
    if (this.operationLabel) {
      this.operationLabel.textContent = error;
      this.operationLabel.addClass('vaultconnect-text-error');
    }

    // Hide current file label
    if (this.currentFileLabel) {
      this.currentFileLabel.addClass('vaultconnect-hidden');
    }

    // Change progress bar color to error
    if (this.progressBarFill) {
      this.progressBarFill.addClass('vaultconnect-bg-error');
    }

    // Hide estimated time
    if (this.estimatedTimeLabel) {
      this.estimatedTimeLabel.addClass('vaultconnect-hidden');
    }

    // Hide cancel button, show close button
    if (this.cancelButton) {
      this.cancelButton.addClass('vaultconnect-hidden');
    }
    if (this.closeButton) {
      this.closeButton.removeClass('vaultconnect-hidden');
    }
  }

  /**
   * Get human-readable text for operation type
   * 
   * @param operation - Operation type
   * @returns Human-readable operation text
   * @private
   */
  private getOperationText(operation: ProgressInfo['operation']): string {
    switch (operation) {
      case 'analyzing':
        return 'Analyzing files...';
      case 'deleting':
        return 'Deleting local files...';
      case 'uploading':
        return 'Uploading files...';
      case 'downloading':
        return 'Downloading files...';
      case 'merging':
        return 'Merging files...';
      default:
        return 'Processing...';
    }
  }

  /**
   * Format time remaining in seconds to human-readable format
   * 
   * @param seconds - Time remaining in seconds
   * @returns Formatted time string
   * @private
   */
  private formatTimeRemaining(seconds: number): string {
    if (seconds < 60) {
      return `${Math.round(seconds)} seconds`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = Math.round(seconds % 60);
      if (remainingSeconds === 0) {
        return `${minutes} minute${minutes === 1 ? '' : 's'}`;
      }
      return `${minutes} minute${minutes === 1 ? '' : 's'} ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      if (minutes === 0) {
        return `${hours} hour${hours === 1 ? '' : 's'}`;
      }
      return `${hours} hour${hours === 1 ? '' : 's'} ${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
