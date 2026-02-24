import { App, Modal, Notice, Setting } from 'obsidian';
import { APIClient } from '../api/APIClient';
import { VaultService } from '../services/VaultService';
import { VaultInfo } from '../types';
import { logger } from '../utils/logger';

export type CopyMoveOperation = 'copy' | 'move';

interface CopyMoveOptions {
  operation: CopyMoveOperation;
  sourceVaultId: string;
  /** Local file paths being operated on */
  filePaths: string[];
}

/**
 * Modal for copying or moving files to another vault.
 * Shows a vault picker and optional destination path input.
 */
export class CopyMoveModal extends Modal {
  private apiClient: APIClient;
  private vaultService: VaultService;
  private options: CopyMoveOptions;
  private onComplete: () => void;

  private vaults: VaultInfo[] = [];
  private selectedVaultId: string = '';
  private destinationPath: string = '';
  private isProcessing: boolean = false;

  private actionButton: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(
    app: App,
    apiClient: APIClient,
    vaultService: VaultService,
    options: CopyMoveOptions,
    onComplete: () => void
  ) {
    super(app);
    this.apiClient = apiClient;
    this.vaultService = vaultService;
    this.options = options;
    this.onComplete = onComplete;
  }

  async onOpen() {
    const { contentEl } = this;
    const op = this.options.operation;
    const fileCount = this.options.filePaths.length;

    contentEl.empty();
    contentEl.addClass('vaultconnect-copymove-modal');

    // Title
    contentEl.createEl('h2', {
      text: op === 'copy' ? 'Copy to vault' : 'Move to vault'
    });

    // File summary
    const summaryEl = contentEl.createDiv({ cls: 'vaultconnect-copymove-summary' });
    if (fileCount === 1) {
      const name = this.options.filePaths[0].split('/').pop() || this.options.filePaths[0];
      summaryEl.textContent = `${op === 'copy' ? 'Copying' : 'Moving'}: ${name}`;
    } else {
      summaryEl.textContent = `${op === 'copy' ? 'Copying' : 'Moving'} ${fileCount} file${fileCount !== 1 ? 's' : ''}`;
    }

    // Loading state while fetching vaults
    const loadingEl = contentEl.createDiv({ cls: 'vaultconnect-copymove-loading' });
    loadingEl.textContent = 'Loading vaults...';

    try {
      this.vaults = await this.vaultService.fetchVaults(true);
    } catch (err: any) {
      loadingEl.textContent = `Failed to load vaults: ${err.message}`;
      return;
    }

    loadingEl.remove();

    // Filter out source vault for move (can't move to same vault without path)
    const availableVaults = this.vaults.filter(v => v.vault_id !== this.options.sourceVaultId);

    if (availableVaults.length === 0) {
      const emptyEl = contentEl.createDiv({ cls: 'vaultconnect-copymove-empty' });
      emptyEl.textContent = 'No other vaults available. Create another vault first.';
      return;
    }

    // Vault selector
    new Setting(contentEl)
      .setName('Destination vault')
      .setDesc('Select the vault to ' + op + ' files to')
      .addDropdown(dropdown => {
        dropdown.addOption('', '-- Select vault --');
        for (const vault of availableVaults) {
          dropdown.addOption(vault.vault_id, vault.name);
        }
        dropdown.onChange(value => {
          this.selectedVaultId = value;
          this.updateActionButton();
        });
      });

    // Destination path
    new Setting(contentEl)
      .setName('Destination folder')
      .setDesc('Optional folder path in the destination vault (leave empty for root)')
      .addText(text => {
        text
          .setPlaceholder('e.g., imported/notes')
          .onChange(value => {
            this.destinationPath = value.trim().replace(/^\/+|\/+$/g, '');
          });
      });

    // Status
    this.statusEl = contentEl.createDiv({ cls: 'vaultconnect-copymove-status' });

    // Buttons
    const buttonContainer = contentEl.createDiv({
      cls: 'vaultconnect-button-container vaultconnect-button-container--end'
    });

    buttonContainer.createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => this.close());

    this.actionButton = buttonContainer.createEl('button', {
      text: op === 'copy' ? 'Copy' : 'Move',
      cls: 'mod-cta'
    });
    this.actionButton.disabled = true;
    this.actionButton.addEventListener('click', () => {
      void this.executeOperation();
    });
  }

  private updateActionButton() {
    if (this.actionButton) {
      this.actionButton.disabled = !this.selectedVaultId || this.isProcessing;
    }
  }

  private async executeOperation() {
    if (!this.selectedVaultId || this.isProcessing) return;

    this.isProcessing = true;
    this.updateActionButton();
    const op = this.options.operation;

    if (this.statusEl) {
      this.statusEl.textContent = op === 'copy' ? 'Copying files...' : 'Moving files...';
      this.statusEl.className = 'vaultconnect-copymove-status';
    }

    try {
      // Resolve local file paths to backend file IDs
      const fileIds = await this.resolveFileIds(this.options.filePaths);

      if (fileIds.length === 0) {
        throw new Error('Could not find files on the server. Ensure files are synced first.');
      }

      if (op === 'copy') {
        const result = await this.apiClient.copyFiles(
          this.options.sourceVaultId,
          fileIds,
          this.destinationPath,
          this.selectedVaultId
        );
        const vaultName = this.getVaultName(this.selectedVaultId);
        new Notice(`Copied ${result.copiedCount} file${result.copiedCount !== 1 ? 's' : ''} to ${vaultName}`);
      } else {
        const result = await this.apiClient.moveFiles(
          this.options.sourceVaultId,
          fileIds,
          this.destinationPath,
          this.selectedVaultId
        );
        const vaultName = this.getVaultName(this.selectedVaultId);
        new Notice(`Moved ${result.movedCount} file${result.movedCount !== 1 ? 's' : ''} to ${vaultName}`);
      }

      this.close();
      this.onComplete();
    } catch (err: any) {
      const message = err?.message || `${op} failed`;
      logger.error(`[CopyMoveModal] ${op} failed:`, err);
      new Notice(`${op === 'copy' ? 'Copy' : 'Move'} failed: ${message}`);

      if (this.statusEl) {
        this.statusEl.textContent = `Error: ${message}`;
        this.statusEl.addClass('vaultconnect-copymove-status--error');
      }
    } finally {
      this.isProcessing = false;
      this.updateActionButton();
    }
  }

  /**
   * Resolve local file paths to backend file IDs by fetching the file list
   */
  private async resolveFileIds(paths: string[]): Promise<string[]> {
    const allFiles = await this.apiClient.listFiles(this.options.sourceVaultId);
    const pathSet = new Set(paths);
    return allFiles
      .filter(f => pathSet.has(f.path))
      .map(f => f.file_id);
  }

  private getVaultName(vaultId: string): string {
    const vault = this.vaults.find(v => v.vault_id === vaultId);
    return vault ? vault.name : vaultId;
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
