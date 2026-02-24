import { App, Modal, Notice, TFile } from 'obsidian';
import { APIClient, SearchResult, SemanticSearchParams } from '../api/APIClient';
import { VaultService } from '../services/VaultService';
import { VaultInfo } from '../types';
import { logger } from '../utils/logger';

/**
 * Semantic Search Modal
 * Searches across synced vaults using the backend semantic search API
 */
export class SearchModal extends Modal {
  private apiClient: APIClient;
  private vaultService: VaultService;
  private localVaultId: string | null;

  private results: SearchResult[] = [];
  private vaults: VaultInfo[] = [];
  private selectedVaultFilter: string = '';
  private isSearching: boolean = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  private inputEl: HTMLInputElement | null = null;
  private resultsContainer: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(
    app: App,
    apiClient: APIClient,
    vaultService: VaultService,
    localVaultId: string | null
  ) {
    super(app);
    this.apiClient = apiClient;
    this.vaultService = vaultService;
    this.localVaultId = localVaultId;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vaultconnect-search-modal');

    // Title
    contentEl.createEl('h2', { text: 'Search Vaults' });

    // Search input
    const searchRow = contentEl.createDiv({ cls: 'vaultconnect-search-input-row' });
    this.inputEl = searchRow.createEl('input', {
      type: 'text',
      placeholder: 'Search across your vaults...',
      cls: 'vaultconnect-search-input'
    });
    this.inputEl.focus();

    this.inputEl.addEventListener('input', () => {
      this.onQueryChange(this.inputEl!.value);
    });

    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.executeSearch(this.inputEl!.value);
      }
    });

    // Filter row
    const filterRow = contentEl.createDiv({ cls: 'vaultconnect-search-filters' });

    // Vault filter
    const vaultSelect = filterRow.createEl('select', {
      cls: 'vaultconnect-search-vault-select'
    });
    vaultSelect.createEl('option', { text: 'All Vaults', value: '' });

    // Load vaults for filter
    try {
      this.vaults = await this.vaultService.fetchVaults(true);
      for (const vault of this.vaults) {
        vaultSelect.createEl('option', {
          text: vault.name,
          value: vault.vault_id
        });
      }
    } catch {
      // Silently fail — filter just won't have vault options
    }

    vaultSelect.addEventListener('change', () => {
      this.selectedVaultFilter = vaultSelect.value;
      if (this.inputEl?.value.trim()) {
        this.executeSearch(this.inputEl.value);
      }
    });

    // Status line
    this.statusEl = contentEl.createDiv({ cls: 'vaultconnect-search-status' });

    // Results container
    this.resultsContainer = contentEl.createDiv({ cls: 'vaultconnect-search-results' });

    // Hint
    const hintEl = contentEl.createDiv({ cls: 'vaultconnect-search-hint' });
    hintEl.textContent = 'Press Enter to search. Results from your synced vaults.';
  }

  private onQueryChange(value: string) {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    if (!value.trim()) {
      this.clearResults();
      return;
    }

    this.debounceTimer = setTimeout(() => {
      this.executeSearch(value);
    }, 400);
  }

  private async executeSearch(query: string) {
    if (!query.trim()) return;
    if (this.isSearching) return;

    this.isSearching = true;
    this.updateStatus('Searching...');
    this.renderLoading();

    try {
      const params: SemanticSearchParams = {
        query: query.trim(),
        limit: 20
      };
      if (this.selectedVaultFilter) {
        params.vault_id = this.selectedVaultFilter;
      }

      const response = await this.apiClient.semanticSearch(params);
      this.results = response.results || [];

      const timeStr = response.executionTimeMs ? ` in ${response.executionTimeMs}ms` : '';
      this.updateStatus(
        `${this.results.length} result${this.results.length !== 1 ? 's' : ''}${timeStr}`
      );
      this.renderResults();
    } catch (err: any) {
      const message = err?.message || 'Search failed';
      this.updateStatus(`Error: ${message}`);
      logger.error('[SearchModal] Search failed:', err);
      new Notice(`Search failed: ${message}`);
      this.clearResults();
    } finally {
      this.isSearching = false;
    }
  }

  private updateStatus(text: string) {
    if (this.statusEl) {
      this.statusEl.textContent = text;
    }
  }

  private clearResults() {
    this.results = [];
    if (this.resultsContainer) {
      this.resultsContainer.empty();
    }
    this.updateStatus('');
  }

  private renderLoading() {
    if (!this.resultsContainer) return;
    this.resultsContainer.empty();

    const loadingEl = this.resultsContainer.createDiv({ cls: 'vaultconnect-search-loading' });
    const spinner = loadingEl.createDiv({ cls: 'vaultsync-loading' });
    loadingEl.createEl('span', { text: ' Searching...' });
  }

  private renderResults() {
    if (!this.resultsContainer) return;
    this.resultsContainer.empty();

    if (this.results.length === 0) {
      const emptyEl = this.resultsContainer.createDiv({ cls: 'vaultconnect-search-empty' });
      emptyEl.textContent = 'No results found. Try a different query.';
      return;
    }

    for (const result of this.results) {
      this.renderResultItem(result);
    }
  }

  private renderResultItem(result: SearchResult) {
    if (!this.resultsContainer) return;

    const item = this.resultsContainer.createDiv({ cls: 'vaultconnect-search-result-item' });

    // Header row: file path + score
    const header = item.createDiv({ cls: 'vaultconnect-search-result-header' });

    const fileName = result.path.split('/').pop() || result.path;
    header.createEl('span', {
      text: fileName,
      cls: 'vaultconnect-search-result-name'
    });

    const score = Math.round(result.similarity_score * 100);
    header.createEl('span', {
      text: `${score}%`,
      cls: 'vaultconnect-search-result-score'
    });

    // Path + vault info
    const meta = item.createDiv({ cls: 'vaultconnect-search-result-meta' });
    const vault = this.vaults.find(v => v.vault_id === result.vault_id);
    const vaultName = vault ? vault.name : 'Unknown vault';
    meta.textContent = `${vaultName} / ${result.path}`;

    // Content preview
    if (result.content_preview) {
      const preview = item.createDiv({ cls: 'vaultconnect-search-result-preview' });
      preview.textContent = result.content_preview.slice(0, 200);
    }

    // Click to open
    item.addEventListener('click', () => {
      this.openResult(result);
    });
  }

  private openResult(result: SearchResult) {
    // If the result is from the currently connected vault, try to open it locally
    if (this.localVaultId && result.vault_id === this.localVaultId) {
      const file = this.app.vault.getAbstractFileByPath(result.path);
      if (file instanceof TFile) {
        this.close();
        this.app.workspace.getLeaf().openFile(file);
        return;
      }
    }

    // If the file isn't local, show a notice with the path
    new Notice(`File: ${result.path} (in vault "${this.getVaultName(result.vault_id)}")`);
    this.close();
  }

  private getVaultName(vaultId: string): string {
    const vault = this.vaults.find(v => v.vault_id === vaultId);
    return vault ? vault.name : vaultId;
  }

  onClose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const { contentEl } = this;
    contentEl.empty();
  }
}
