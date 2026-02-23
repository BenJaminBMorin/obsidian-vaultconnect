import { App, Modal, Notice } from 'obsidian';
import { VaultService } from '../services/VaultService';
import { VaultInfo } from '../types';

/**
 * Modal for browsing and selecting a VaultConnect vault
 */
export class VaultBrowserModal extends Modal {
  private vaultService: VaultService;
  private onSelect: (vaultId: string) => void;
  private vaults: VaultInfo[] = [];
  private loading = true;
  private error: string | null = null;
  private searchQuery = '';

  constructor(
    app: App,
    vaultService: VaultService,
    onSelect: (vaultId: string) => void
  ) {
    super(app);
    this.vaultService = vaultService;
    this.onSelect = onSelect;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vaultconnect-vault-browser');

    contentEl.createEl('h2', { text: 'Select a Vault' });

    // Search input
    const searchContainer = contentEl.createDiv({ cls: 'vaultconnect-vault-browser-search' });
    const searchInput = searchContainer.createEl('input', {
      type: 'text',
      placeholder: 'Search vaults...',
      cls: 'vaultconnect-vault-browser-search-input',
    });

    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value.toLowerCase();
      this.renderVaultList(listContainer);
    });

    // Vault list container
    const listContainer = contentEl.createDiv({ cls: 'vaultconnect-vault-browser-list' });

    // Load vaults
    this.renderLoading(listContainer);
    try {
      this.vaults = await this.vaultService.fetchVaults(true);
      this.loading = false;
    } catch (err) {
      this.loading = false;
      this.error = err instanceof Error ? err.message : 'Failed to load vaults';
    }

    this.renderVaultList(listContainer);
  }

  private renderLoading(container: HTMLElement) {
    container.empty();
    const loadingEl = container.createDiv({ cls: 'vaultconnect-vault-browser-loading' });
    loadingEl.setText('Loading vaults...');
  }

  private renderVaultList(container: HTMLElement) {
    container.empty();

    if (this.loading) {
      this.renderLoading(container);
      return;
    }

    if (this.error) {
      const errorEl = container.createDiv({ cls: 'vaultconnect-vault-browser-message vaultconnect-vault-browser-message--error' });
      errorEl.setText(this.error);
      return;
    }

    const filtered = this.vaults.filter(v =>
      v.name.toLowerCase().includes(this.searchQuery) ||
      v.vault_id.toLowerCase().includes(this.searchQuery)
    );

    if (filtered.length === 0) {
      const emptyEl = container.createDiv({ cls: 'vaultconnect-vault-browser-message' });
      emptyEl.setText(this.vaults.length === 0 ? 'No vaults found. Create one from the web UI.' : 'No vaults match your search.');
      return;
    }

    for (const vault of filtered) {
      this.renderVaultItem(container, vault);
    }
  }

  private renderVaultItem(container: HTMLElement, vault: VaultInfo) {
    const item = container.createDiv({ cls: 'vaultconnect-vault-browser-item' });

    // Header row: name + badge
    const headerRow = item.createDiv({ cls: 'vaultconnect-vault-browser-item-header' });

    const nameEl = headerRow.createEl('span', { cls: 'vaultconnect-vault-browser-item-name' });
    nameEl.setText(vault.name);

    if (vault.is_cross_tenant) {
      const badge = headerRow.createEl('span', { cls: 'vaultconnect-vault-browser-item-badge' });
      const permLabel = vault.permission === 'read' ? 'Read' : vault.permission === 'write' ? 'Write' : 'Admin';
      badge.setText(`Shared (${permLabel})`);
    }

    // Details row
    const detailsRow = item.createDiv({ cls: 'vaultconnect-vault-browser-item-details' });
    detailsRow.createEl('span', { text: `${vault.file_count} files` });
    detailsRow.createEl('span', { text: this.formatBytes(vault.total_size_bytes) });

    // ID row (small)
    const idRow = item.createDiv({ cls: 'vaultconnect-vault-browser-item-id' });
    idRow.setText(vault.vault_id);

    // Click to select
    item.addEventListener('click', () => {
      this.onSelect(vault.vault_id);
      new Notice(`Selected vault: ${vault.name}`);
      this.close();
    });
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  onClose() {
    this.contentEl.empty();
  }
}
