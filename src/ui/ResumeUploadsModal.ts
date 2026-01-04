import { Modal, App, Setting } from 'obsidian';
import { PersistedUploadState } from '../services/UploadPersistenceService';

/**
 * Resume Uploads Modal
 * Shows list of incomplete uploads that can be resumed
 */
export class ResumeUploadsModal extends Modal {
  private uploads: PersistedUploadState[];
  private onResume: (uploadId: string) => Promise<void>;
  private onDiscard: (uploadId: string) => Promise<void>;
  private onDiscardAll: () => Promise<void>;

  constructor(
    app: App,
    uploads: PersistedUploadState[],
    onResume: (uploadId: string) => Promise<void>,
    onDiscard: (uploadId: string) => Promise<void>,
    onDiscardAll: () => Promise<void>
  ) {
    super(app);
    this.uploads = uploads;
    this.onResume = onResume;
    this.onDiscard = onDiscard;
    this.onDiscardAll = onDiscardAll;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('resume-uploads-modal');

    // Title
    contentEl.createEl('h2', { text: 'Resume incomplete uploads' });

    // Description
    const desc = contentEl.createDiv({ cls: 'resume-uploads-description' });
    desc.createEl('p', {
      text: `Found ${this.uploads.length} incomplete upload${this.uploads.length !== 1 ? 's' : ''}. ` +
            `You can resume where you left off or discard them.`
    });

    // Upload list
    const listContainer = contentEl.createDiv({ cls: 'resume-uploads-list' });

    this.uploads.forEach(upload => {
      const uploadItem = listContainer.createDiv({ cls: 'resume-upload-item' });

      // File info
      const fileInfo = uploadItem.createDiv({ cls: 'resume-upload-info' });
      fileInfo.createEl('div', {
        text: upload.filePath,
        cls: 'resume-upload-filename'
      });

      const progress = (upload.uploadedChunks.length / upload.totalChunks) * 100;
      const stats = fileInfo.createDiv({ cls: 'resume-upload-stats' });
      stats.createEl('span', {
        text: `${progress.toFixed(0)}% complete`,
        cls: 'resume-upload-progress'
      });
      stats.createEl('span', {
        text: ` • ${upload.uploadedChunks.length}/${upload.totalChunks} chunks`,
        cls: 'resume-upload-chunks'
      });
      stats.createEl('span', {
        text: ` • ${this.formatSize(upload.totalSize)}`,
        cls: 'resume-upload-size'
      });
      stats.createEl('span', {
        text: ` • ${this.formatAge(upload.lastUpdate)}`,
        cls: 'resume-upload-age'
      });

      // Progress bar
      const progressBar = uploadItem.createDiv({ cls: 'resume-upload-progress-bar' });
      const progressFill = progressBar.createDiv({ cls: 'resume-upload-progress-fill' });
      progressFill.style.width = `${progress}%`;

      // Actions
      const actions = uploadItem.createDiv({ cls: 'resume-upload-actions' });

      new Setting(actions)
        .addButton(btn => btn
          .setButtonText('Resume')
          .setCta()
          .onClick(async () => {
            await this.onResume(upload.uploadId);
            this.close();
          }))
        .addButton(btn => btn
          .setButtonText('Discard')
          .setWarning()
          .onClick(async () => {
            await this.onDiscard(upload.uploadId);
            // Remove from list
            this.uploads = this.uploads.filter(u => u.uploadId !== upload.uploadId);
            if (this.uploads.length === 0) {
              this.close();
            } else {
              this.onOpen(); // Refresh
            }
          }));
    });

    // Bottom actions
    const bottomActions = contentEl.createDiv({ cls: 'resume-uploads-bottom-actions' });

    new Setting(bottomActions)
      .addButton(btn => btn
        .setButtonText('Discard all')
        .setWarning()
        .onClick(async () => {
          await this.onDiscardAll();
          this.close();
        }))
      .addButton(btn => btn
        .setButtonText('Close')
        .onClick(() => this.close()));
  }

  /**
   * Format file size
   */
  private formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 10) / 10 + ' ' + sizes[i];
  }

  /**
   * Format age
   */
  private formatAge(timestamp: number): string {
    const age = Date.now() - timestamp;
    const minutes = Math.floor(age / 60000);
    const hours = Math.floor(age / 3600000);
    const days = Math.floor(age / 86400000);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
  }
}
