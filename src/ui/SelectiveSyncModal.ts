import { App, Modal, Setting, Notice, TFile } from 'obsidian';
import { SelectiveSyncService, SyncScopeStats } from '../services/SelectiveSyncService';

/**
 * Modal for configuring selective sync settings
 */
export class SelectiveSyncModal extends Modal {
  private selectiveSyncService: SelectiveSyncService;
  private onSave: () => void;
  private previewStats: SyncScopeStats | null = null;

  constructor(
    app: App,
    selectiveSyncService: SelectiveSyncService,
    onSave: () => void
  ) {
    super(app);
    this.selectiveSyncService = selectiveSyncService;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Selective sync configuration' });

    // Description
    contentEl.createEl('p', {
      text: 'Configure which folders to include or exclude from sync. Excluded folders take precedence over included folders.',
      cls: 'setting-item-description'
    });

    // Excluded Folders Section
    this.createExcludedFoldersSection(contentEl);

    // Included Folders Section
    this.createIncludedFoldersSection(contentEl);

    // Preview Section
    this.createPreviewSection(contentEl);

    // Common Folders Quick Toggles
    this.createQuickTogglesSection(contentEl);

    // Action Buttons
    this.createActionButtons(contentEl);
  }

  private createExcludedFoldersSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Excluded folders').setHeading();

    const config = this.selectiveSyncService.getConfig();

    // List current excluded folders
    const excludedList = containerEl.createDiv({ cls: 'selective-sync-folder-list' });
    this.renderFolderList(excludedList, config.excludedFolders, 'excluded');

    // Add excluded folder
    new Setting(containerEl)
      .setName('Add excluded folder')
      .setDesc('Enter a folder path or pattern to exclude (e.g., "private" or "drafts/*")')
      .addText(text => {
        text.setPlaceholder('folder/path');
        text.inputEl.addEventListener('keypress', async (e) => {
          if (e.key === 'Enter') {
            const value = text.getValue().trim();
            if (value) {
              const validation = this.selectiveSyncService.validatePattern(value);
              if (validation.valid) {
                this.selectiveSyncService.addExcludedFolder(value);
                text.setValue('');
                this.refresh();
                new Notice(`Added excluded folder: ${value}`);
              } else {
                new Notice(`Invalid pattern: ${validation.error}`, 5000);
              }
            }
          }
        });
      })
      .addButton(button => {
        button
          .setButtonText('Add')
          .onClick(async () => {
            const input = containerEl.querySelector('input[placeholder="folder/path"]') as HTMLInputElement;
            const value = input?.value.trim();
            if (value) {
              const validation = this.selectiveSyncService.validatePattern(value);
              if (validation.valid) {
                this.selectiveSyncService.addExcludedFolder(value);
                input.value = '';
                this.refresh();
                new Notice(`Added excluded folder: ${value}`);
              } else {
                new Notice(`Invalid pattern: ${validation.error}`, 5000);
              }
            }
          });
      });
  }

  private createIncludedFoldersSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Included folders (optional)').setHeading();

    containerEl.createEl('p', {
      text: 'If specified, only these folders will be synced (except those explicitly excluded). Leave empty to sync all folders except excluded ones.',
      cls: 'setting-item-description'
    });

    const config = this.selectiveSyncService.getConfig();

    // List current included folders
    const includedList = containerEl.createDiv({ cls: 'selective-sync-folder-list' });
    this.renderFolderList(includedList, config.includedFolders, 'included');

    // Add included folder
    new Setting(containerEl)
      .setName('Add included folder')
      .setDesc('Enter a folder path or pattern to include (e.g., "notes" or "docs/*")')
      .addText(text => {
        text.setPlaceholder('folder/path');
        text.inputEl.addEventListener('keypress', async (e) => {
          if (e.key === 'Enter') {
            const value = text.getValue().trim();
            if (value) {
              const validation = this.selectiveSyncService.validatePattern(value);
              if (validation.valid) {
                this.selectiveSyncService.addIncludedFolder(value);
                text.setValue('');
                this.refresh();
                new Notice(`Added included folder: ${value}`);
              } else {
                new Notice(`Invalid pattern: ${validation.error}`, 5000);
              }
            }
          }
        });
      })
      .addButton(button => {
        button
          .setButtonText('Add')
          .onClick(async () => {
            const input = containerEl.querySelectorAll('input[placeholder="folder/path"]')[1] as HTMLInputElement;
            const value = input?.value.trim();
            if (value) {
              const validation = this.selectiveSyncService.validatePattern(value);
              if (validation.valid) {
                this.selectiveSyncService.addIncludedFolder(value);
                input.value = '';
                this.refresh();
                new Notice(`Added included folder: ${value}`);
              } else {
                new Notice(`Invalid pattern: ${validation.error}`, 5000);
              }
            }
          });
      });

    // Clear all included folders
    if (config.includedFolders.length > 0) {
      new Setting(containerEl)
        .setName('Clear all included folders')
        .setDesc('Remove all included folders (sync all except excluded)')
        .addButton(button => {
          button
            .setButtonText('Clear all')
            .setWarning()
            .onClick(() => {
              this.selectiveSyncService.clearIncludedFolders();
              this.refresh();
              new Notice('Cleared all included folders');
            });
        });
    }
  }

  private createPreviewSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Sync scope preview').setHeading();

    const previewContainer = containerEl.createDiv({ cls: 'selective-sync-preview' });

    new Setting(previewContainer)
      .setName('Calculate preview')
      .setDesc('See how many files will be synced with current settings')
      .addButton(button => {
        button
          .setButtonText('Calculate')
          .onClick(() => {
            const files = this.app.vault.getMarkdownFiles();
            this.previewStats = this.selectiveSyncService.getSyncScopePreview(files);
            this.renderPreview(previewContainer);
          });
      });

    if (this.previewStats) {
      this.renderPreview(previewContainer);
    }
  }

  private renderPreview(containerEl: HTMLElement): void {
    if (!this.previewStats) return;

    // Remove old preview if exists
    const oldPreview = containerEl.querySelector('.preview-stats');
    if (oldPreview) {
      oldPreview.remove();
    }

    const statsDiv = containerEl.createDiv({ cls: 'preview-stats' });
    
    statsDiv.createEl('div', {
      text: `Total files: ${this.previewStats.totalFiles}`,
      cls: 'preview-stat'
    });
    
    statsDiv.createEl('div', {
      text: `Files to sync: ${this.previewStats.includedFiles} (${this.getPercentage(this.previewStats.includedFiles, this.previewStats.totalFiles)}%)`,
      cls: 'preview-stat preview-stat-included'
    });
    
    statsDiv.createEl('div', {
      text: `Files excluded: ${this.previewStats.excludedFiles} (${this.getPercentage(this.previewStats.excludedFiles, this.previewStats.totalFiles)}%)`,
      cls: 'preview-stat preview-stat-excluded'
    });
  }

  private getPercentage(value: number, total: number): string {
    if (total === 0) return '0';
    return ((value / total) * 100).toFixed(1);
  }

  private createQuickTogglesSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Quick toggles').setHeading();

    containerEl.createEl('p', {
      text: 'Quickly add common folders to exclusions',
      cls: 'setting-item-description'
    });

    const commonFolders = this.selectiveSyncService.getCommonFolders();
    const config = this.selectiveSyncService.getConfig();

    const togglesContainer = containerEl.createDiv({ cls: 'selective-sync-quick-toggles' });

    for (const folder of commonFolders) {
      const isExcluded = config.excludedFolders.includes(folder);
      const isIncluded = config.includedFolders.includes(folder);

      const toggleDiv = togglesContainer.createDiv({ cls: 'quick-toggle-item' });
      
      toggleDiv.createEl('span', { 
        text: folder,
        cls: 'quick-toggle-label'
      });

      const buttonContainer = toggleDiv.createDiv({ cls: 'quick-toggle-buttons' });

      // Exclude button
      const excludeBtn = buttonContainer.createEl('button', {
        text: isExcluded ? '✓ Excluded' : 'Exclude',
        cls: isExcluded ? 'quick-toggle-btn active' : 'quick-toggle-btn'
      });
      excludeBtn.addEventListener('click', () => {
        if (isExcluded) {
          this.selectiveSyncService.removeExcludedFolder(folder);
        } else {
          this.selectiveSyncService.addExcludedFolder(folder);
        }
        this.refresh();
      });

      // Include button
      const includeBtn = buttonContainer.createEl('button', {
        text: isIncluded ? '✓ Included' : 'Include',
        cls: isIncluded ? 'quick-toggle-btn active' : 'quick-toggle-btn'
      });
      includeBtn.addEventListener('click', () => {
        if (isIncluded) {
          this.selectiveSyncService.removeIncludedFolder(folder);
        } else {
          this.selectiveSyncService.addIncludedFolder(folder);
        }
        this.refresh();
      });
    }
  }

  private renderFolderList(
    containerEl: HTMLElement,
    folders: string[],
    type: 'included' | 'excluded'
  ): void {
    containerEl.empty();

    if (folders.length === 0) {
      containerEl.createEl('p', {
        text: `No ${type} folders configured`,
        cls: 'selective-sync-empty'
      });
      return;
    }

    const listEl = containerEl.createEl('ul', { cls: 'selective-sync-list' });

    for (const folder of folders) {
      const itemEl = listEl.createEl('li', { cls: 'selective-sync-list-item' });
      
      itemEl.createEl('span', {
        text: folder,
        cls: 'folder-name'
      });

      const removeBtn = itemEl.createEl('button', {
        text: '×',
        cls: 'selective-sync-remove-btn'
      });

      removeBtn.addEventListener('click', () => {
        if (type === 'excluded') {
          this.selectiveSyncService.removeExcludedFolder(folder);
        } else {
          this.selectiveSyncService.removeIncludedFolder(folder);
        }
        this.refresh();
        new Notice(`Removed ${type} folder: ${folder}`);
      });
    }
  }

  private createActionButtons(containerEl: HTMLElement): void {
    const buttonContainer = containerEl.createDiv({ cls: 'modal-button-container' });

    // Reset to defaults
    new Setting(buttonContainer)
      .addButton(button => {
        button
          .setButtonText('Reset to defaults')
          .setWarning()
          .onClick(() => {
            this.selectiveSyncService.resetExcludedFolders();
            this.selectiveSyncService.clearIncludedFolders();
            this.refresh();
            new Notice('Reset to default settings');
          });
      });

    // Save and close
    new Setting(buttonContainer)
      .addButton(button => {
        button
          .setButtonText('Save & close')
          .setCta()
          .onClick(() => {
            this.onSave();
            this.close();
            new Notice('Selective sync settings saved');
          });
      });
  }

  private refresh(): void {
    this.onOpen();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
