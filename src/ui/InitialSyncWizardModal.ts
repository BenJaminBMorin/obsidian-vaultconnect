import { App, Modal, Notice } from 'obsidian';
import { InitialSyncService } from '../services/InitialSyncService';
import { FileAnalysis, InitialSyncOption, ProgressInfo } from '../types/initial-sync.types';
import { InitialSyncProgressModal } from './InitialSyncProgressModal';

/**
 * Options for the Initial Sync Wizard Modal
 */
export interface InitialSyncWizardOptions {
  /** The VaultSync vault ID */
  vaultId: string;
  /** The vault name for display */
  vaultName: string;
  /** File analysis results */
  analysis: FileAnalysis;
  /** Callback when sync completes successfully */
  onComplete: (option: InitialSyncOption) => Promise<void>;
  /** Callback when user cancels */
  onCancel: () => void;
}

/**
 * Initial Sync Wizard Modal
 * 
 * Displays file analysis and presents three sync options to the user:
 * - Smart Merge (recommended)
 * - Start Fresh
 * - Upload Local
 */
export class InitialSyncWizardModal extends Modal {
  private options: InitialSyncWizardOptions;
  private initialSyncService: InitialSyncService;
  private progressModal: InitialSyncProgressModal | null = null;
  private eventBus: any; // EventBus instance

  constructor(
    app: App,
    options: InitialSyncWizardOptions,
    initialSyncService: InitialSyncService,
    eventBus: any
  ) {
    super(app);
    this.options = options;
    this.initialSyncService = initialSyncService;
    this.eventBus = eventBus;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('initial-sync-wizard-modal');

    // Header
    contentEl.createEl('h2', { text: 'Initial Sync Setup' });

    // Introduction
    const intro = contentEl.createDiv({ cls: 'initial-sync-intro' });
    intro.style.marginBottom = '20px';
    intro.style.color = 'var(--text-muted)';
    intro.textContent = `This is your first time connecting to "${this.options.vaultName}". Let's set up how to handle your existing files.`;

    // Render file analysis summary
    this.renderAnalysisSummary(contentEl);

    // Render sync options
    this.renderOptions(contentEl);

    // Cancel button
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    buttonContainer.style.marginTop = '20px';
    buttonContainer.style.textAlign = 'right';

    const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.options.onCancel();
      this.close();
    });
  }

  /**
   * Render sync option cards
   * Shows three options: Smart Merge, Start Fresh, Upload Local
   * 
   * @private
   */
  private renderOptions(container: HTMLElement): void {
    const optionsContainer = container.createDiv({ cls: 'initial-sync-options' });
    optionsContainer.style.marginBottom = '20px';

    // Title
    const title = optionsContainer.createEl('h3', { text: 'Choose how to proceed:' });
    title.style.marginBottom = '15px';

    const { analysis } = this.options;

    // Smart Merge option (recommended)
    this.renderOptionCard(
      optionsContainer,
      {
        icon: '🔄',
        title: 'Smart Merge',
        badge: 'Recommended',
        badgeColor: 'var(--interactive-accent)',
        description: 'Intelligently merge files from both locations:',
        bullets: [
          'Upload files only on this device',
          'Download files only on VaultSync',
          'Create conflict copies for different files'
        ],
        benefits: [
          '✓ No data loss',
          '✓ Safe for important files'
        ],
        buttonText: 'Select Smart Merge',
        buttonClass: 'mod-cta',
        onClick: () => this.handleSmartMerge()
      }
    );

    // Start Fresh option
    this.renderOptionCard(
      optionsContainer,
      {
        icon: '⬇️',
        title: 'Start Fresh',
        badge: 'Warning',
        badgeColor: 'var(--text-error)',
        description: 'Clear this device and download from VaultSync',
        bullets: analysis.localFiles.length > 0 || analysis.commonFiles.length > 0
          ? [`⚠️  Will delete ${analysis.localFiles.length + analysis.commonFiles.length} local file${analysis.localFiles.length + analysis.commonFiles.length === 1 ? '' : 's'}`]
          : ['No local files will be deleted'],
        benefits: [],
        buttonText: 'Select Start Fresh',
        buttonClass: '',
        onClick: () => this.handleStartFresh()
      }
    );

    // Upload Local option
    this.renderOptionCard(
      optionsContainer,
      {
        icon: '⬆️',
        title: 'Upload Local Files',
        badge: analysis.commonFiles.length > 0 ? 'Warning' : undefined,
        badgeColor: 'var(--text-error)',
        description: 'Upload all files from this device to VaultSync',
        bullets: analysis.commonFiles.length > 0
          ? [`⚠️  Will overwrite ${analysis.commonFiles.length} remote file${analysis.commonFiles.length === 1 ? '' : 's'}`]
          : ['No remote files will be overwritten'],
        benefits: [],
        buttonText: 'Select Upload Local',
        buttonClass: '',
        onClick: () => this.handleUploadLocal()
      }
    );
  }

  /**
   * Render a single option card
   * 
   * @private
   */
  private renderOptionCard(
    container: HTMLElement,
    config: {
      icon: string;
      title: string;
      badge?: string;
      badgeColor?: string;
      description: string;
      bullets: string[];
      benefits: string[];
      buttonText: string;
      buttonClass: string;
      onClick: () => void;
    }
  ): void {
    const card = container.createDiv({ cls: 'sync-option-card' });
    card.style.marginBottom = '15px';
    card.style.padding = '15px';
    card.style.border = '1px solid var(--background-modifier-border)';
    card.style.borderRadius = '6px';
    card.style.backgroundColor = 'var(--background-primary)';
    card.style.transition = 'border-color 0.2s, box-shadow 0.2s';

    // Hover effect
    card.addEventListener('mouseenter', () => {
      card.style.borderColor = 'var(--interactive-accent)';
      card.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.1)';
    });
    card.addEventListener('mouseleave', () => {
      card.style.borderColor = 'var(--background-modifier-border)';
      card.style.boxShadow = 'none';
    });

    // Header with icon, title, and badge
    const header = card.createDiv({ cls: 'option-header' });
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '10px';
    header.style.marginBottom = '10px';

    const icon = header.createSpan({ text: config.icon });
    icon.style.fontSize = '1.5em';

    const titleEl = header.createEl('h4', { text: config.title });
    titleEl.style.margin = '0';
    titleEl.style.flex = '1';

    if (config.badge) {
      const badge = header.createSpan({ text: config.badge });
      badge.style.padding = '2px 8px';
      badge.style.borderRadius = '4px';
      badge.style.fontSize = '0.75em';
      badge.style.fontWeight = 'bold';
      badge.style.color = 'white';
      badge.style.backgroundColor = config.badgeColor || 'var(--text-muted)';
    }

    // Description
    const desc = card.createDiv({ text: config.description });
    desc.style.marginBottom = '10px';
    desc.style.color = 'var(--text-muted)';

    // Bullets
    if (config.bullets.length > 0) {
      const bulletList = card.createEl('ul');
      bulletList.style.marginLeft = '20px';
      bulletList.style.marginBottom = '10px';
      bulletList.style.fontSize = '0.9em';

      config.bullets.forEach(bullet => {
        const li = bulletList.createEl('li', { text: bullet });
        if (bullet.includes('⚠️')) {
          li.style.color = 'var(--text-error)';
        }
      });
    }

    // Benefits
    if (config.benefits.length > 0) {
      const benefitsContainer = card.createDiv({ cls: 'benefits' });
      benefitsContainer.style.marginBottom = '10px';
      benefitsContainer.style.fontSize = '0.9em';
      benefitsContainer.style.color = 'var(--text-success)';

      config.benefits.forEach(benefit => {
        const benefitEl = benefitsContainer.createDiv({ text: benefit });
        benefitEl.style.marginBottom = '4px';
      });
    }

    // Button
    const button = card.createEl('button', { 
      text: config.buttonText,
      cls: config.buttonClass 
    });
    button.style.width = '100%';
    button.addEventListener('click', config.onClick);
  }

  /**
   * Render file analysis summary
   * Shows counts of files in different categories
   * 
   * @private
   */
  private renderAnalysisSummary(container: HTMLElement): void {
    const summaryContainer = container.createDiv({ cls: 'initial-sync-summary' });
    summaryContainer.style.marginBottom = '20px';
    summaryContainer.style.padding = '15px';
    summaryContainer.style.border = '1px solid var(--background-modifier-border)';
    summaryContainer.style.borderRadius = '6px';
    summaryContainer.style.backgroundColor = 'var(--background-secondary)';

    // Title
    const title = summaryContainer.createEl('h3', { text: '📊 File Analysis' });
    title.style.marginTop = '0';
    title.style.marginBottom = '12px';
    title.style.fontSize = '1em';

    // File counts
    const countsContainer = summaryContainer.createDiv({ cls: 'file-counts' });
    countsContainer.style.display = 'flex';
    countsContainer.style.flexDirection = 'column';
    countsContainer.style.gap = '8px';

    const { analysis } = this.options;

    // Files only on device
    if (analysis.localFiles.length > 0) {
      const localRow = countsContainer.createDiv({ cls: 'count-row' });
      localRow.style.display = 'flex';
      localRow.style.alignItems = 'center';
      localRow.style.gap = '8px';
      
      const icon = localRow.createSpan({ text: '📱' });
      const text = localRow.createSpan({ 
        text: `${analysis.localFiles.length} file${analysis.localFiles.length === 1 ? '' : 's'} only on this device` 
      });
      text.style.color = 'var(--text-normal)';
    }

    // Files only on VaultSync
    if (analysis.remoteFiles.length > 0) {
      const remoteRow = countsContainer.createDiv({ cls: 'count-row' });
      remoteRow.style.display = 'flex';
      remoteRow.style.alignItems = 'center';
      remoteRow.style.gap = '8px';
      
      const icon = remoteRow.createSpan({ text: '☁️' });
      const text = remoteRow.createSpan({ 
        text: `${analysis.remoteFiles.length} file${analysis.remoteFiles.length === 1 ? '' : 's'} only on VaultSync` 
      });
      text.style.color = 'var(--text-normal)';
    }

    // Files in both locations
    if (analysis.commonFiles.length > 0) {
      const bothRow = countsContainer.createDiv({ cls: 'count-row' });
      bothRow.style.display = 'flex';
      bothRow.style.alignItems = 'center';
      bothRow.style.gap = '8px';
      
      const icon = bothRow.createSpan({ text: '🔄' });
      const text = bothRow.createSpan({ 
        text: `${analysis.commonFiles.length} file${analysis.commonFiles.length === 1 ? '' : 's'} in both locations` 
      });
      text.style.color = 'var(--text-normal)';
    }

    // Excluded files
    if (analysis.excludedFiles.length > 0) {
      const excludedRow = countsContainer.createDiv({ cls: 'count-row' });
      excludedRow.style.display = 'flex';
      excludedRow.style.alignItems = 'center';
      excludedRow.style.gap = '8px';
      
      const icon = excludedRow.createSpan({ text: '🚫' });
      const configDir = this.app.vault.configDir;
      const text = excludedRow.createSpan({
        text: `${analysis.excludedFiles.length} file${analysis.excludedFiles.length === 1 ? '' : 's'} excluded (${configDir}, .trash)`
      });
      text.style.color = 'var(--text-muted)';
      text.style.fontSize = '0.9em';
    }

    // Empty vault message
    if (analysis.localFiles.length === 0 && 
        analysis.remoteFiles.length === 0 && 
        analysis.commonFiles.length === 0) {
      const emptyMsg = countsContainer.createDiv({ cls: 'empty-message' });
      emptyMsg.textContent = 'Both vaults are empty. You can start syncing right away!';
      emptyMsg.style.color = 'var(--text-muted)';
      emptyMsg.style.fontStyle = 'italic';
    }
  }

  /**
   * Show confirmation dialog for destructive operations
   * 
   * @param option - The sync option being confirmed
   * @param fileCount - Number of files affected
   * @returns Promise that resolves to true if confirmed, false if cancelled
   * @private
   */
  private async showConfirmation(
    option: InitialSyncOption,
    fileCount: number
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      
      modal.onOpen = () => {
        const { contentEl } = modal;
        contentEl.empty();
        contentEl.addClass('initial-sync-confirmation-modal');

        if (option === InitialSyncOption.START_FRESH) {
          // Start Fresh confirmation - requires typing "DELETE"
          contentEl.createEl('h2', { text: '⚠️  Confirm: Start Fresh' });

          const warning = contentEl.createDiv({ cls: 'confirmation-warning' });
          warning.style.marginBottom = '15px';
          warning.style.padding = '10px';
          warning.style.backgroundColor = 'var(--background-modifier-error)';
          warning.style.borderRadius = '4px';
          warning.style.color = 'var(--text-error)';

          warning.createEl('p', { 
            text: `This will DELETE ${fileCount} file${fileCount === 1 ? '' : 's'} from this device:` 
          });

          // Show sample files
          const { analysis } = this.options;
          const filesToShow = [...analysis.localFiles, ...analysis.commonFiles].slice(0, 5);
          const fileList = warning.createEl('ul');
          fileList.style.marginLeft = '20px';
          fileList.style.fontSize = '0.9em';
          
          filesToShow.forEach(file => {
            fileList.createEl('li', { text: file });
          });

          if (fileCount > 5) {
            fileList.createEl('li', { text: `... and ${fileCount - 5} more files` });
          }

          warning.createEl('p', { 
            text: 'These files will be permanently deleted and replaced with files from VaultSync.',
            cls: 'mod-warning'
          });

          // Input for typing DELETE
          const inputContainer = contentEl.createDiv({ cls: 'confirmation-input' });
          inputContainer.style.marginBottom = '15px';

          inputContainer.createEl('p', { 
            text: 'Type DELETE to confirm:',
            cls: 'setting-item-name'
          });

          let deleteInput = '';
          const input = inputContainer.createEl('input', { 
            type: 'text',
            placeholder: 'DELETE'
          });
          input.style.width = '100%';
          input.style.padding = '8px';
          input.style.fontSize = '1em';
          input.style.border = '1px solid var(--background-modifier-border)';
          input.style.borderRadius = '4px';
          input.addEventListener('input', (e) => {
            deleteInput = (e.target as HTMLInputElement).value;
            confirmButton.disabled = deleteInput !== 'DELETE';
          });

          // Focus input
          setTimeout(() => input.focus(), 100);

          // Buttons
          const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
          buttonContainer.style.marginTop = '20px';
          buttonContainer.style.display = 'flex';
          buttonContainer.style.justifyContent = 'flex-end';
          buttonContainer.style.gap = '10px';

          const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
          cancelButton.addEventListener('click', () => {
            modal.close();
            resolve(false);
          });

          const confirmButton = buttonContainer.createEl('button', { 
            text: 'Confirm Delete',
            cls: 'mod-warning'
          });
          confirmButton.disabled = true;
          confirmButton.addEventListener('click', () => {
            if (deleteInput === 'DELETE') {
              modal.close();
              resolve(true);
            }
          });

          // Handle Enter key
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && deleteInput === 'DELETE') {
              e.preventDefault();
              modal.close();
              resolve(true);
            }
          });

        } else if (option === InitialSyncOption.UPLOAD_LOCAL) {
          // Upload Local confirmation - simpler warning
          contentEl.createEl('h2', { text: '⚠️  Confirm: Upload Local Files' });

          const warning = contentEl.createDiv({ cls: 'confirmation-warning' });
          warning.style.marginBottom = '15px';
          warning.style.padding = '10px';
          warning.style.backgroundColor = 'var(--background-modifier-error)';
          warning.style.borderRadius = '4px';
          warning.style.color = 'var(--text-error)';

          warning.createEl('p', { 
            text: `This will overwrite ${fileCount} file${fileCount === 1 ? '' : 's'} on VaultSync with your local versions.` 
          });

          warning.createEl('p', { 
            text: 'The remote versions of these files will be lost.',
            cls: 'mod-warning'
          });

          // Buttons
          const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
          buttonContainer.style.marginTop = '20px';
          buttonContainer.style.display = 'flex';
          buttonContainer.style.justifyContent = 'flex-end';
          buttonContainer.style.gap = '10px';

          const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
          cancelButton.addEventListener('click', () => {
            modal.close();
            resolve(false);
          });

          const confirmButton = buttonContainer.createEl('button', { 
            text: 'Confirm Upload',
            cls: 'mod-warning'
          });
          confirmButton.addEventListener('click', () => {
            modal.close();
            resolve(true);
          });
        }
      };

      modal.onClose = () => {
        // If modal is closed without clicking a button, treat as cancel
        resolve(false);
      };

      modal.open();
    });
  }

  /**
   * Handle Smart Merge option
   * 
   * @private
   */
  private async handleSmartMerge(): Promise<void> {
    try {
      // Close wizard modal
      this.close();

      // Show progress modal
      this.progressModal = new InitialSyncProgressModal(
        this.app,
        () => this.initialSyncService.cancelOperation()
      );
      this.progressModal.open();

      // Listen for progress events
      const progressHandler = (info: ProgressInfo) => {
        this.progressModal?.updateProgress(info);
      };
      const unsubscribe = this.eventBus.on('initial-sync:progress', progressHandler);

      // Execute smart merge
      const result = await this.initialSyncService.executeSmartMerge(
        this.options.vaultId,
        this.options.analysis
      );

      // Mark sync complete (only if successful)
      await this.initialSyncService.markSyncComplete(
        this.options.vaultId,
        InitialSyncOption.SMART_MERGE,
        this.options.analysis
      );

      // Show completion
      let summary = `Successfully merged files! `;
      summary += `Uploaded: ${result.uploaded}, Downloaded: ${result.downloaded}`;
      if (result.conflicts.length > 0) {
        summary += `, Conflicts: ${result.conflicts.length}`;
      }
      if (result.errors.length > 0) {
        summary += ` (${result.errors.length} errors)`;
      }

      this.progressModal?.showComplete(summary);

      // Clean up event listener
      unsubscribe();

      // Call completion callback
      await this.options.onComplete(InitialSyncOption.SMART_MERGE);

      // Show notice about conflicts if any
      if (result.conflicts.length > 0) {
        new Notice(`${result.conflicts.length} conflict${result.conflicts.length === 1 ? '' : 's'} created. Check your vault for files with "(conflict)" in the name.`);
      }
    } catch (error) {
      console.error('[InitialSyncWizard] Smart merge failed:', error);
      
      // Clean up event listener
      const unsubscribe = this.eventBus.on('initial-sync:progress', () => {});
      unsubscribe();
      
      // Determine if error was due to cancellation
      const isCancelled = error.message && error.message.includes('cancelled');
      
      if (isCancelled) {
        this.progressModal?.showError('Operation cancelled. Your vault may be in a partial state. You can restart the initial sync from settings.');
        new Notice('Initial sync cancelled. You can restart from settings.');
      } else {
        this.progressModal?.showError(error.message || 'Smart merge failed. You can retry from settings.');
        new Notice(`Smart merge failed: ${error.message}`);
      }
      
      // Do NOT mark sync as complete on error/cancellation
      // This allows the user to restart the initial sync
    }
  }

  /**
   * Handle Start Fresh option
   * 
   * @private
   */
  private async handleStartFresh(): Promise<void> {
    const { analysis } = this.options;
    const filesToDelete = analysis.localFiles.length + analysis.commonFiles.length;

    // Show confirmation dialog
    const confirmed = await this.showConfirmation(
      InitialSyncOption.START_FRESH,
      filesToDelete
    );

    if (!confirmed) {
      return;
    }

    try {
      // Close wizard modal
      this.close();

      // Show progress modal
      this.progressModal = new InitialSyncProgressModal(
        this.app,
        () => this.initialSyncService.cancelOperation()
      );
      this.progressModal.open();

      // Listen for progress events
      const progressHandler = (info: ProgressInfo) => {
        this.progressModal?.updateProgress(info);
      };
      const unsubscribe = this.eventBus.on('initial-sync:progress', progressHandler);

      // Execute start fresh
      const result = await this.initialSyncService.executeStartFresh(
        this.options.vaultId,
        this.options.analysis
      );

      // Mark sync complete (only if successful)
      await this.initialSyncService.markSyncComplete(
        this.options.vaultId,
        InitialSyncOption.START_FRESH,
        this.options.analysis
      );

      // Show completion
      let summary = `Successfully started fresh! `;
      summary += `Deleted: ${result.deleted}, Downloaded: ${result.downloaded}`;
      if (result.errors.length > 0) {
        summary += ` (${result.errors.length} errors)`;
      }

      this.progressModal?.showComplete(summary);

      // Clean up event listener
      unsubscribe();

      // Call completion callback
      await this.options.onComplete(InitialSyncOption.START_FRESH);
    } catch (error) {
      console.error('[InitialSyncWizard] Start fresh failed:', error);
      
      // Clean up event listener
      const unsubscribe = this.eventBus.on('initial-sync:progress', () => {});
      unsubscribe();
      
      // Determine if error was due to cancellation
      const isCancelled = error.message && error.message.includes('cancelled');
      
      if (isCancelled) {
        this.progressModal?.showError('Operation cancelled. Some files may have been deleted or downloaded. You can restart the initial sync from settings.');
        new Notice('Initial sync cancelled. You can restart from settings.');
      } else {
        this.progressModal?.showError(error.message || 'Start fresh failed. You can retry from settings.');
        new Notice(`Start fresh failed: ${error.message}`);
      }
      
      // Do NOT mark sync as complete on error/cancellation
      // This allows the user to restart the initial sync
    }
  }

  /**
   * Handle Upload Local option
   * 
   * @private
   */
  private async handleUploadLocal(): Promise<void> {
    const { analysis } = this.options;
    const filesToOverwrite = analysis.commonFiles.length;

    // Show confirmation dialog if there are files to overwrite
    if (filesToOverwrite > 0) {
      const confirmed = await this.showConfirmation(
        InitialSyncOption.UPLOAD_LOCAL,
        filesToOverwrite
      );

      if (!confirmed) {
        return;
      }
    }

    try {
      // Close wizard modal
      this.close();

      // Show progress modal
      this.progressModal = new InitialSyncProgressModal(
        this.app,
        () => this.initialSyncService.cancelOperation()
      );
      this.progressModal.open();

      // Listen for progress events
      const progressHandler = (info: ProgressInfo) => {
        this.progressModal?.updateProgress(info);
      };
      const unsubscribe = this.eventBus.on('initial-sync:progress', progressHandler);

      // Execute upload local
      const result = await this.initialSyncService.executeUploadLocal(
        this.options.vaultId,
        this.options.analysis
      );

      // Mark sync complete (only if successful)
      await this.initialSyncService.markSyncComplete(
        this.options.vaultId,
        InitialSyncOption.UPLOAD_LOCAL,
        this.options.analysis
      );

      // Show completion
      let summary = `Successfully uploaded local files! `;
      summary += `Uploaded: ${result.uploaded}`;
      if (result.errors.length > 0) {
        summary += ` (${result.errors.length} errors)`;
      }

      this.progressModal?.showComplete(summary);

      // Clean up event listener
      unsubscribe();

      // Call completion callback
      await this.options.onComplete(InitialSyncOption.UPLOAD_LOCAL);
    } catch (error) {
      console.error('[InitialSyncWizard] Upload local failed:', error);
      
      // Clean up event listener
      const unsubscribe = this.eventBus.on('initial-sync:progress', () => {});
      unsubscribe();
      
      // Determine if error was due to cancellation
      const isCancelled = error.message && error.message.includes('cancelled');
      
      if (isCancelled) {
        this.progressModal?.showError('Operation cancelled. Some files may have been uploaded. You can restart the initial sync from settings.');
        new Notice('Initial sync cancelled. You can restart from settings.');
      } else {
        this.progressModal?.showError(error.message || 'Upload local failed. You can retry from settings.');
        new Notice(`Upload local failed: ${error.message}`);
      }
      
      // Do NOT mark sync as complete on error/cancellation
      // This allows the user to restart the initial sync
    }
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
