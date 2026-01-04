import { Modal, App, Setting } from 'obsidian';
import { UploadProgress } from '../services/LargeFileService';

/**
 * Upload Progress Modal
 * Shows detailed progress for large file uploads
 */
export class UploadProgressModal extends Modal {
  private progress: UploadProgress;
  private cancelCallback: () => void;
  private contentContainer: HTMLElement;
  private progressBar: HTMLElement;
  private statsContainer: HTMLElement;

  constructor(
    app: App,
    progress: UploadProgress,
    cancelCallback: () => void
  ) {
    super(app);
    this.progress = progress;
    this.cancelCallback = cancelCallback;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('upload-progress-modal');

    // Title
    contentEl.createEl('h2', { text: 'Uploading file' });

    // File info
    const fileInfo = contentEl.createDiv({ cls: 'upload-file-info' });
    fileInfo.createEl('p', { 
      text: `File: ${this.progress.filePath}`,
      cls: 'upload-filename'
    });
    fileInfo.createEl('p', {
      text: `Size: ${this.formatBytes(this.progress.totalSize)}`,
      cls: 'upload-filesize'
    });

    // Progress bar container
    const progressContainer = contentEl.createDiv({ cls: 'upload-progress-container' });
    this.progressBar = progressContainer.createDiv({ cls: 'upload-progress-bar' });
    this.updateProgressBar();

    // Percentage text
    const percentText = contentEl.createDiv({ cls: 'upload-percent-text' });
    percentText.setText(`${this.progress.percentComplete.toFixed(1)}%`);

    // Stats container
    this.statsContainer = contentEl.createDiv({ cls: 'upload-stats' });
    this.updateStats();

    // Buttons
    const buttonContainer = contentEl.createDiv({ cls: 'upload-buttons' });
    
    new Setting(buttonContainer)
      .addButton(btn => btn
        .setButtonText('Cancel upload')
        .setWarning()
        .onClick(() => {
          this.cancelCallback();
          this.close();
        }));
  }

  /**
   * Update progress display
   */
  updateProgress(progress: UploadProgress): void {
    this.progress = progress;
    
    if (this.progressBar) {
      this.updateProgressBar();
    }
    
    if (this.statsContainer) {
      this.updateStats();
    }
    
    // Update percent text
    const percentText = this.contentEl.querySelector('.upload-percent-text');
    if (percentText) {
      percentText.setText(`${progress.percentComplete.toFixed(1)}%`);
    }
  }

  /**
   * Update progress bar width
   */
  private updateProgressBar(): void {
    this.progressBar.style.width = `${this.progress.percentComplete}%`;
  }

  /**
   * Update stats display
   */
  private updateStats(): void {
    this.statsContainer.empty();
    
    const stats = [
      {
        label: 'Progress',
        value: `${this.progress.percentComplete.toFixed(1)}%`
      },
      {
        label: 'Speed',
        value: `${this.formatBytes(this.progress.speed)}/s`
      },
      {
        label: 'Uploaded',
        value: `${this.formatBytes(this.progress.uploadedSize)} / ${this.formatBytes(this.progress.totalSize)}`
      },
      {
        label: 'Time Remaining',
        value: this.formatTime(this.progress.estimatedTimeRemaining)
      },
      {
        label: 'Chunks',
        value: `${this.progress.uploadedChunks} / ${this.progress.totalChunks}`
      },
      {
        label: 'Current Chunk',
        value: `#${this.progress.currentChunk}`
      }
    ];

    stats.forEach(stat => {
      const statEl = this.statsContainer.createDiv({ cls: 'upload-stat' });
      statEl.createEl('span', { text: stat.label, cls: 'upload-stat-label' });
      statEl.createEl('span', { text: stat.value, cls: 'upload-stat-value' });
    });
  }

  /**
   * Format bytes to human readable
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Format time to human readable
   */
  private formatTime(seconds: number): string {
    if (seconds < 0 || !isFinite(seconds)) return 'Calculating...';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    
    if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const secs = Math.round(seconds % 60);
      return `${minutes}m ${secs}s`;
    }
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
}
