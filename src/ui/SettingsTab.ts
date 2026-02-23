import { App, PluginSettingTab, Setting, Notice, TextComponent } from 'obsidian';
import VaultSyncPlugin from '../../main';
import { DeviceAuthModal } from './DeviceAuthModal';
import { showConfirmationModal } from './ConfirmationModal';
import { SyncMode, PluginSettings, VaultInfo } from '../types';
import { SyncService } from '../services/SyncService';
import { InitialSyncService } from '../services/InitialSyncService';
import { InitialSyncState } from '../types/initial-sync.types';
import { SettingsManager } from '../core/SettingsManager';
import { CacheService } from '../services/CacheService';
import { ServerDiscoveryService, ServerConfig } from '../services/ServerDiscoveryService';
import { logger } from '../utils/logger';

/**
 * Plugin extension interface for accessing internal services
 */
interface PluginWithServices {
  syncService?: SyncService | null;
  settingsManager?: SettingsManager | null;
  cacheService?: CacheService | null;
}

type OnboardingStage = 'NEEDS_SERVER' | 'NEEDS_AUTH' | 'NEEDS_VAULT' | 'COMPLETE';

/**
 * Settings Tab for VaultConnect Plugin
 * Provides a staged onboarding flow + full configuration UI
 */
export class VaultSyncSettingTab extends PluginSettingTab {
  plugin: VaultSyncPlugin;
  private discoveryService: ServerDiscoveryService;
  private cachedServerConfig: ServerConfig | null = null;

  constructor(app: App, plugin: VaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.discoveryService = new ServerDiscoveryService();
  }

  /**
   * Determine the current onboarding stage
   */
  private getStage(): OnboardingStage {
    if (!this.plugin.settings.apiBaseURL) {
      return 'NEEDS_SERVER';
    }

    if (!this.plugin.authService || !this.plugin.authService.isAuthenticated()) {
      return 'NEEDS_AUTH';
    }

    if (!this.plugin.settings.selectedVaultId && !this.plugin.settings.vaultId) {
      return 'NEEDS_VAULT';
    }

    return 'COMPLETE';
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const stage = this.getStage();

    switch (stage) {
      case 'NEEDS_SERVER':
        this.displayServerStage(containerEl);
        break;
      case 'NEEDS_AUTH':
        this.displayAuthStage(containerEl);
        break;
      case 'NEEDS_VAULT':
        this.displayVaultStage(containerEl);
        break;
      case 'COMPLETE':
        this.displayCompleteStage(containerEl);
        break;
    }
  }

  // ===========================================================================
  // Stage: NEEDS_SERVER
  // ===========================================================================

  private displayServerStage(containerEl: HTMLElement): void {
    const wrapper = containerEl.createDiv({ cls: 'vaultconnect-onboarding' });

    // Step indicator
    this.displayStepIndicator(wrapper, 1);

    // Header
    wrapper.createEl('h2', { text: 'Welcome to VaultConnect', cls: 'vaultconnect-onboarding-header' });
    wrapper.createEl('p', {
      text: 'Enter your VaultConnect server URL to get started.',
      cls: 'setting-item-description'
    });

    // Server URL input
    const inputContainer = wrapper.createDiv({ cls: 'vaultconnect-server-input-container' });
    let serverUrlInput: HTMLInputElement;

    new Setting(inputContainer)
      .setName('Server URL')
      .setDesc('Your VaultConnect web or API URL')
      .addText(text => {
        text
          .setPlaceholder('https://app.vaultsync.morinclan.com')
          .setValue(this.plugin.settings.serverUrl || '');
        serverUrlInput = text.inputEl;
        serverUrlInput.addClass('vaultconnect-server-input');
      });

    // Status area for discovery feedback
    const statusEl = wrapper.createDiv({ cls: 'vaultconnect-discovery-status' });

    // Connect button
    const btnContainer = wrapper.createDiv({ cls: 'vaultconnect-onboarding-actions' });
    const connectBtn = btnContainer.createEl('button', { text: 'Connect', cls: 'mod-cta' });

    connectBtn.addEventListener('click', () => {
      void this.handleServerConnect(serverUrlInput.value, statusEl, connectBtn, wrapper);
    });

    // Allow Enter key to submit
    inputContainer.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        connectBtn.click();
      }
    });
  }

  private async handleServerConnect(
    url: string,
    statusEl: HTMLElement,
    connectBtn: HTMLButtonElement,
    wrapper: HTMLElement
  ): Promise<void> {
    statusEl.empty();
    statusEl.removeClass('is-error', 'is-success');

    if (!url.trim()) {
      statusEl.addClass('is-error');
      statusEl.setText('Please enter a server URL');
      return;
    }

    // Show loading
    connectBtn.disabled = true;
    connectBtn.setText('Discovering...');
    const spinner = statusEl.createDiv({ cls: 'vaultconnect-discovery-spinner' });
    spinner.createDiv({ cls: 'spinner' });
    spinner.createEl('span', { text: 'Looking up server configuration...' });

    try {
      const config = await this.discoveryService.discover(url);
      this.cachedServerConfig = config;

      // Save discovered URLs to settings
      this.plugin.settings.serverUrl = url.trim();
      this.plugin.settings.apiBaseURL = config.apiUrl;
      this.plugin.settings.apiUrl = config.apiUrl;
      this.plugin.settings.wsBaseURL = config.wsUrl;
      this.plugin.settings.wsUrl = config.wsUrl;
      await this.plugin.saveSettings();

      // Re-initialize services with new API URL
      if (this.plugin.apiClient) {
        this.plugin.apiClient.setBaseURL(config.apiUrl);
      }

      // Show success briefly then move to next stage
      statusEl.empty();
      statusEl.addClass('is-success');
      statusEl.setText(`Connected to VaultConnect ${config.version}`);

      // Short delay then refresh to next stage
      setTimeout(() => this.display(), 500);
    } catch (error) {
      statusEl.empty();
      statusEl.addClass('is-error');
      statusEl.setText(error.message || 'Failed to discover server');

      // Show manual fallback
      this.displayManualFallback(wrapper);
    } finally {
      connectBtn.disabled = false;
      connectBtn.setText('Connect');
    }
  }

  private displayManualFallback(wrapper: HTMLElement): void {
    // Check if fallback already shown
    if (wrapper.querySelector('.vaultconnect-manual-fallback')) return;

    const fallback = wrapper.createDiv({ cls: 'vaultconnect-manual-fallback' });

    const details = fallback.createEl('details');
    details.createEl('summary', { text: 'Manual configuration' });

    const content = details.createDiv({ cls: 'vaultconnect-manual-fields' });

    // API URL
    new Setting(content)
      .setName('API URL')
      .setDesc('Direct API server URL')
      .addText(text => {
        text
          .setPlaceholder('https://api.vaultsync.morinclan.com/v1')
          .setValue(this.plugin.settings.apiBaseURL || '');
      });

    // WebSocket URL
    new Setting(content)
      .setName('WebSocket URL')
      .setDesc('WebSocket server URL')
      .addText(text => {
        text
          .setPlaceholder('https://api.vaultsync.morinclan.com')
          .setValue(this.plugin.settings.wsBaseURL || '');
      });

    // Save manual config button
    const saveBtnContainer = content.createDiv({ cls: 'vaultconnect-onboarding-actions' });
    const saveBtn = saveBtnContainer.createEl('button', { text: 'Save & continue', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => {
      const apiInput = content.querySelectorAll('input')[0] as HTMLInputElement;
      const wsInput = content.querySelectorAll('input')[1] as HTMLInputElement;

      const apiUrl = apiInput?.value?.trim();
      const wsUrl = wsInput?.value?.trim();

      if (!apiUrl) {
        new Notice('API URL is required');
        return;
      }

      this.plugin.settings.apiBaseURL = apiUrl;
      this.plugin.settings.apiUrl = apiUrl;
      this.plugin.settings.wsBaseURL = wsUrl || apiUrl;
      this.plugin.settings.wsUrl = wsUrl || apiUrl;
      this.plugin.settings.serverUrl = apiUrl;

      void (async () => {
        await this.plugin.saveSettings();
        if (this.plugin.apiClient) {
          this.plugin.apiClient.setBaseURL(apiUrl);
        }
        this.display();
      })();
    });
  }

  // ===========================================================================
  // Stage: NEEDS_AUTH
  // ===========================================================================

  private displayAuthStage(containerEl: HTMLElement): void {
    const wrapper = containerEl.createDiv({ cls: 'vaultconnect-onboarding' });

    // Step indicator
    this.displayStepIndicator(wrapper, 2);

    // Header
    wrapper.createEl('h2', { text: 'Sign in', cls: 'vaultconnect-onboarding-header' });

    // Show connected server info
    const serverInfo = wrapper.createDiv({ cls: 'vaultconnect-server-info' });
    const serverLabel = this.plugin.settings.serverUrl || this.plugin.settings.apiBaseURL;
    const versionText = this.cachedServerConfig?.version ? ` (v${this.cachedServerConfig.version})` : '';
    serverInfo.createEl('span', { text: `Server: ${serverLabel}${versionText}` });

    const changeLink = serverInfo.createEl('a', { text: 'Change', cls: 'vaultconnect-change-link' });
    changeLink.addEventListener('click', (e) => {
      e.preventDefault();
      // Clear server config to go back to server stage
      this.plugin.settings.apiBaseURL = '';
      this.plugin.settings.apiUrl = '';
      this.plugin.settings.wsBaseURL = '';
      this.plugin.settings.wsUrl = '';
      this.plugin.settings.serverUrl = '';
      void (async () => {
        await this.plugin.saveSettings();
        this.display();
      })();
    });

    wrapper.createEl('p', {
      text: 'Sign in via your browser to connect your account.',
      cls: 'setting-item-description'
    });

    // Sign in button
    const btnContainer = wrapper.createDiv({ cls: 'vaultconnect-onboarding-actions' });
    const signInBtn = btnContainer.createEl('button', { text: 'Sign in with browser', cls: 'mod-cta' });

    signInBtn.addEventListener('click', () => {
      if (!this.plugin.authService) {
        new Notice('Auth service not available');
        return;
      }

      new DeviceAuthModal(
        this.app,
        this.plugin.authService,
        this.plugin.settings.apiBaseURL,
        () => {
          // On success, sync apiKey to settings
          const authState = this.plugin.authService?.getAuthState();
          if (authState?.apiKey) {
            this.plugin.settings.apiKey = authState.apiKey;
            this.plugin.settings.apiKeyExpires = authState.expiresAt;
          }
          void this.plugin.saveSettings().then(() => this.display());
        },
        () => {
          // Cancelled
        }
      ).open();
    });

    if (this.cachedServerConfig?.googleOAuthEnabled) {
      wrapper.createEl('p', {
        text: 'Google sign-in is available on the authorization page.',
        cls: 'setting-item-description vaultconnect-oauth-hint'
      });
    }
  }

  // ===========================================================================
  // Stage: NEEDS_VAULT
  // ===========================================================================

  private displayVaultStage(containerEl: HTMLElement): void {
    const wrapper = containerEl.createDiv({ cls: 'vaultconnect-onboarding' });

    // Step indicator
    this.displayStepIndicator(wrapper, 3);

    // Header
    wrapper.createEl('h2', { text: 'Select a vault', cls: 'vaultconnect-onboarding-header' });

    // Auth status
    const authInfo = wrapper.createDiv({ cls: 'vaultconnect-auth-status-line' });
    authInfo.createEl('span', { text: 'Signed in', cls: 'vaultconnect-status-ok' });

    const logoutLink = authInfo.createEl('a', { text: 'Sign out', cls: 'vaultconnect-change-link' });
    logoutLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.plugin.authService) {
        void this.plugin.authService.clearApiKey().then(() => {
          this.plugin.settings.apiKey = null;
          this.plugin.settings.apiKeyExpires = null;
          void this.plugin.saveSettings().then(() => this.display());
        });
      }
    });

    wrapper.createEl('p', {
      text: 'Choose which vault to sync with this Obsidian vault.',
      cls: 'setting-item-description'
    });

    // Vault list container
    const vaultListEl = wrapper.createDiv({ cls: 'vaultconnect-vault-picker' });
    const loadingEl = vaultListEl.createDiv({ cls: 'vaultconnect-vault-picker-loading' });
    loadingEl.createDiv({ cls: 'spinner' });
    loadingEl.createEl('span', { text: 'Loading vaults...' });

    // Load vaults
    void this.loadVaultsForPicker(vaultListEl, wrapper);
  }

  private async loadVaultsForPicker(vaultListEl: HTMLElement, wrapper: HTMLElement): Promise<void> {
    try {
      const vaults = await this.plugin.apiClient?.listVaults();

      vaultListEl.empty();

      if (!vaults || vaults.length === 0) {
        vaultListEl.createEl('p', {
          text: 'No vaults found. Create a vault in the VaultConnect web UI first.',
          cls: 'setting-item-description'
        });
        return;
      }

      // Render vault cards
      for (const vault of vaults) {
        const card = vaultListEl.createDiv({ cls: 'vaultconnect-vault-card' });

        const nameEl = card.createDiv({ cls: 'vaultconnect-vault-card-name' });
        nameEl.setText(vault.name);

        const infoEl = card.createDiv({ cls: 'vaultconnect-vault-card-info' });
        infoEl.setText(`${vault.file_count || 0} files`);

        if (vault.is_cross_tenant) {
          const badge = card.createEl('span', { cls: 'vaultconnect-vault-card-badge' });
          badge.setText('Shared');
        }

        card.addEventListener('click', () => {
          void this.selectVaultAndFinish(vault, wrapper);
        });
      }

      // Refresh button
      const refreshContainer = vaultListEl.createDiv({ cls: 'vaultconnect-onboarding-actions' });
      const refreshBtn = refreshContainer.createEl('button', { text: 'Refresh list' });
      refreshBtn.addEventListener('click', () => {
        vaultListEl.empty();
        const loading = vaultListEl.createDiv({ cls: 'vaultconnect-vault-picker-loading' });
        loading.createDiv({ cls: 'spinner' });
        loading.createEl('span', { text: 'Loading vaults...' });
        void this.loadVaultsForPicker(vaultListEl, wrapper);
      });
    } catch (error) {
      vaultListEl.empty();
      vaultListEl.createEl('p', {
        text: `Failed to load vaults: ${error.message}`,
        cls: 'setting-item-description vaultconnect-error-text'
      });
    }
  }

  private async selectVaultAndFinish(vault: VaultInfo, wrapper: HTMLElement): Promise<void> {
    this.plugin.settings.selectedVaultId = vault.vault_id;
    this.plugin.settings.vaultId = vault.vault_id;
    await this.plugin.saveSettings();

    new Notice(`Vault "${vault.name}" selected!`);

    // Move to complete stage
    this.display();
  }

  // ===========================================================================
  // Stage: COMPLETE
  // ===========================================================================

  private displayCompleteStage(containerEl: HTMLElement): void {
    // Compact connection header
    this.displayConnectionHeader(containerEl);

    // Show all setting sections
    this.displaySyncSection(containerEl);
    this.displaySelectiveSyncSection(containerEl);
    this.displayCollaborationSection(containerEl);
    this.displayNotificationSection(containerEl);
    this.displayPerformanceSection(containerEl);
    this.displayAdvancedSection(containerEl);
  }

  private displayConnectionHeader(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('VaultConnect').setHeading();

    const authState = this.plugin.authService?.getAuthState();
    const isAuthed = authState?.isAuthenticated ?? false;
    const vaultId = this.plugin.settings.selectedVaultId || this.plugin.settings.vaultId;

    // Connection status row
    const statusDesc = isAuthed ? 'Signed in' : 'Not signed in';
    const vaultName = vaultId ? vaultId.substring(0, 8) + '...' : 'None';

    new Setting(containerEl)
      .setName('Status')
      .setDesc(`${isAuthed ? '🟢' : '⚫'} ${statusDesc} | Vault: ${vaultName}`)
      .addButton(button => {
        if (isAuthed) {
          button
            .setButtonText('Sign out')
            .setWarning()
            .onClick(async () => {
              if (this.plugin.authService) {
                // Disconnect first
                if (this.plugin.isConnected) {
                  this.plugin.disconnect();
                }
                await this.plugin.authService.clearApiKey();
                this.plugin.settings.apiKey = null;
                this.plugin.settings.apiKeyExpires = null;
                await this.plugin.saveSettings();
                new Notice('Signed out');
                this.display();
              }
            });
        } else {
          button
            .setButtonText('Sign in')
            .setCta()
            .onClick(() => {
              if (this.plugin.authService) {
                new DeviceAuthModal(
                  this.app,
                  this.plugin.authService,
                  this.plugin.settings.apiBaseURL,
                  () => {
                    const state = this.plugin.authService?.getAuthState();
                    if (state?.apiKey) {
                      this.plugin.settings.apiKey = state.apiKey;
                      this.plugin.settings.apiKeyExpires = state.expiresAt;
                    }
                    void this.plugin.saveSettings().then(() => this.display());
                  },
                  () => {}
                ).open();
              }
            });
        }
      });

    // API Key info (if authenticated)
    if (isAuthed && authState?.apiKey) {
      const maskedKey = authState.apiKey.substring(0, 12) + '****' + authState.apiKey.substring(authState.apiKey.length - 4);

      new Setting(containerEl)
        .setName('API key')
        .setDesc(maskedKey);

      if (authState.expiresAt && this.plugin.authService) {
        const daysUntilExpiration = this.plugin.authService.getDaysUntilExpiration();
        const expirationText = daysUntilExpiration !== null
          ? `Expires in ${daysUntilExpiration} days`
          : 'Expired';

        const isExpiringSoon = this.plugin.authService.isTokenExpiringSoon();

        new Setting(containerEl)
          .setName('Expiration')
          .setDesc(expirationText)
          .then(setting => {
            if (isExpiringSoon) {
              setting.descEl.addClass('vaultconnect-text-error');
            }
          });
      }
    }

    // Vault selector
    this.displayVaultSelector(containerEl);
  }

  private displayVaultSelector(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Vault selection').setHeading();

    const vaultSetting = new Setting(containerEl)
      .setName('Vault')
      .setDesc('Select the vault to sync with');

    const controlsContainer = vaultSetting.controlEl.createDiv({ cls: 'vaultconnect-vault-selector' });
    const dropdown = controlsContainer.createEl('select', { cls: 'dropdown vaultconnect-vault-dropdown' });
    const refreshButton = controlsContainer.createEl('button', { text: 'Refresh', cls: 'mod-cta vaultconnect-refresh-btn' });
    const loadingEl = controlsContainer.createEl('span', { text: 'Loading...', cls: 'vaultconnect-loading' });

    const loadVaults = async () => {
      if (!this.plugin.settings.apiKey && !this.plugin.authService?.isAuthenticated()) {
        dropdown.empty();
        dropdown.createEl('option', { text: 'Sign in first', value: '' });
        dropdown.disabled = true;
        refreshButton.disabled = true;
        return;
      }

      try {
        loadingEl.addClass('is-visible');
        refreshButton.disabled = true;
        dropdown.disabled = true;

        const vaults = await this.plugin.apiClient?.listVaults();

        dropdown.empty();

        if (!vaults || vaults.length === 0) {
          dropdown.createEl('option', { text: 'No vaults found', value: '' });
        } else {
          dropdown.createEl('option', { text: 'Select a vault...', value: '' });

          vaults.forEach((vault: VaultInfo) => {
            const option = dropdown.createEl('option', {
              text: `${vault.name} (${vault.file_count || 0} files)`,
              value: vault.vault_id
            });
            const currentVaultId = this.plugin.settings.selectedVaultId || this.plugin.settings.vaultId;
            if (vault.vault_id === currentVaultId) {
              option.selected = true;
            }
          });
        }

        dropdown.disabled = false;
      } catch (error) {
        logger.error('Failed to load vaults:', error);
        dropdown.empty();
        dropdown.createEl('option', { text: 'Error loading vaults', value: '' });
      } finally {
        loadingEl.removeClass('is-visible');
        refreshButton.disabled = false;
      }
    };

    dropdown.addEventListener('change', () => {
      void (async () => {
        const selectedVaultId = dropdown.value;
        if (selectedVaultId) {
          this.plugin.settings.selectedVaultId = selectedVaultId;
          this.plugin.settings.vaultId = selectedVaultId;
          await this.plugin.saveSettings();
          new Notice(`Vault selected. Disconnect and reconnect to sync with this vault.`);
        }
      })();
    });

    refreshButton.addEventListener('click', () => { void loadVaults(); });

    if (this.plugin.settings.apiKey || this.plugin.authService?.isAuthenticated()) {
      void loadVaults();
    } else {
      dropdown.createEl('option', { text: 'Sign in first', value: '' });
      dropdown.disabled = true;
      refreshButton.disabled = true;
    }

    // Cross-tenant vault status
    const currentVaultId = this.plugin.settings.selectedVaultId || this.plugin.settings.vaultId;
    if (this.plugin.vaultService && currentVaultId) {
      const vault = this.plugin.vaultService.getCurrentVault();
      if (vault?.is_cross_tenant) {
        const permissionIcon = vault.permission === 'read' ? '👁️' : vault.permission === 'write' ? '✏️' : '👑';
        const permissionLabel = vault.permission === 'read' ? 'Read-only' : vault.permission === 'write' ? 'Read-write' : 'Admin';
        const statusEl = containerEl.createDiv({ cls: 'vaultsync-vault-status' });
        statusEl.createEl('div', {
          text: `🔗 Cross-tenant vault (${permissionIcon} ${permissionLabel})`,
          cls: 'vaultsync-cross-tenant-badge'
        });
      }
    }

    // Device ID (read-only)
    new Setting(containerEl)
      .setName('Device ID')
      .setDesc('Unique identifier for this device')
      .addText(text => {
        text.setValue(this.plugin.settings.deviceId);
        text.inputEl.disabled = true;
      });
  }

  // ===========================================================================
  // Shared UI Helper
  // ===========================================================================

  private displayStepIndicator(containerEl: HTMLElement, currentStep: number): void {
    const indicator = containerEl.createDiv({ cls: 'vaultconnect-stage-indicator' });
    for (let i = 1; i <= 3; i++) {
      const dot = indicator.createDiv({ cls: 'vaultconnect-stage-dot' });
      if (i === currentStep) dot.addClass('is-active');
      if (i < currentStep) dot.addClass('is-completed');
    }
  }

  // ===========================================================================
  // Full settings sections (shown in COMPLETE stage)
  // ===========================================================================

  private displaySyncSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Sync').setHeading();

    const syncModeDesc = containerEl.createDiv({ cls: 'vaultsync-sync-mode-desc' });

    new Setting(containerEl)
      .setName('Sync mode')
      .setDesc('Choose how files should be synchronized')
      .addDropdown(dropdown => {
        dropdown
          .addOption(SyncMode.SMART_SYNC, 'Smart sync (recommended)')
          .addOption(SyncMode.PULL_ALL, 'Pull all')
          .addOption(SyncMode.PUSH_ALL, 'Push all')
          .addOption(SyncMode.MANUAL, 'Manual')
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            this.plugin.settings.syncMode = value as SyncMode;
            await this.plugin.saveSettings();
            this.updateSyncModeDescription(syncModeDesc, value as SyncMode);
            new Notice(`Sync mode changed to ${this.getSyncModeLabel(value as SyncMode)}`);
          });
      });

    this.updateSyncModeDescription(syncModeDesc, this.plugin.settings.syncMode);

    new Setting(containerEl)
      .setName('Auto sync')
      .setDesc('Automatically sync file changes as you work')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
            new Notice(`Auto sync ${value ? 'enabled' : 'disabled'}`);
          });
      });

    new Setting(containerEl)
      .setName('Sync interval')
      .setDesc('How often to check for changes (10-300 seconds)')
      .addText(text => {
        this.addNumberValidation(text,
          this.plugin.settings.syncInterval,
          async (value) => {
            if (value >= 10 && value <= 300) {
              this.plugin.settings.syncInterval = value;
              await this.plugin.saveSettings();
              return true;
            }
            return false;
          },
          'Sync interval must be between 10 and 300 seconds'
        );
        text.inputEl.type = 'number';
      });
  }

  private updateSyncModeDescription(containerEl: HTMLElement, mode: SyncMode): void {
    containerEl.empty();

    const descriptions: Record<string, string> = {
      [SyncMode.SMART_SYNC]: 'Bidirectional sync with automatic conflict detection. Changes are synced both ways, and conflicts are detected before overwriting.',
      [SyncMode.PULL_ALL]: 'Download all remote files. Local changes are preserved as conflict copies if they differ from remote.',
      [SyncMode.PUSH_ALL]: 'Upload all local files. Remote versions are overwritten with local content.',
      [SyncMode.MANUAL]: 'No automatic sync. Use commands to manually sync files when needed.'
    };

    containerEl.createEl('p', {
      text: descriptions[mode],
      cls: 'setting-item-description vaultsync-mode-description'
    });
  }

  private getSyncModeLabel(mode: SyncMode): string {
    const labels: Record<string, string> = {
      [SyncMode.SMART_SYNC]: 'Smart sync',
      [SyncMode.PULL_ALL]: 'Pull all',
      [SyncMode.PUSH_ALL]: 'Push all',
      [SyncMode.MANUAL]: 'Manual'
    };
    return labels[mode];
  }

  private displaySelectiveSyncSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Selective sync').setHeading();

    const scopeSummary = this.getSyncScopeSummary();
    new Setting(containerEl)
      .setName('Sync scope')
      .setDesc(scopeSummary)
      .addButton(button => {
        button
          .setButtonText('Configure')
          .onClick(() => {
            this.openSelectiveSyncModal();
          });
      });

    const excludedFolders = this.plugin.settings.excludedFolders;
    const excludedDisplay = excludedFolders.length > 0
      ? excludedFolders.slice(0, 3).join(', ') + (excludedFolders.length > 3 ? '...' : '')
      : 'None';

    const configDir = this.app.vault.configDir;
    new Setting(containerEl)
      .setName('Excluded folders')
      .setDesc(excludedDisplay)
      .addTextArea(text => {
        text
          .setPlaceholder(`${configDir}, .trash, private/`)
          .setValue(this.plugin.settings.excludedFolders.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = value
              .split(',')
              .map(f => f.trim())
              .filter(f => f.length > 0);
            await this.plugin.saveSettings();

            const pluginExt = this.plugin as unknown as PluginWithServices;
            if (pluginExt.syncService) {
              pluginExt.syncService.setExcludedFolders(this.plugin.settings.excludedFolders);
            }
          });
        text.inputEl.rows = 3;
      });

    const includedFolders = this.plugin.settings.includedFolders;
    const includedDisplay = includedFolders.length > 0
      ? includedFolders.slice(0, 3).join(', ') + (includedFolders.length > 3 ? '...' : '')
      : 'All (except excluded)';

    new Setting(containerEl)
      .setName('Included folders')
      .setDesc(includedDisplay)
      .addTextArea(text => {
        text
          .setPlaceholder('Enter folders (e.g., notes/, docs/)')
          .setValue(this.plugin.settings.includedFolders.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.includedFolders = value
              .split(',')
              .map(f => f.trim())
              .filter(f => f.length > 0);
            await this.plugin.saveSettings();

            const pluginExt = this.plugin as unknown as PluginWithServices;
            if (pluginExt.syncService) {
              pluginExt.syncService.setIncludedFolders(this.plugin.settings.includedFolders);
            }
          });
        text.inputEl.rows = 3;
      });
  }

  private getSyncScopeSummary(): string {
    const includedCount = this.plugin.settings.includedFolders.length;
    const excludedCount = this.plugin.settings.excludedFolders.length;

    if (includedCount > 0) {
      return `Syncing ${includedCount} included folder${includedCount > 1 ? 's' : ''}, excluding ${excludedCount} folder${excludedCount > 1 ? 's' : ''}`;
    } else {
      return `Syncing all folders except ${excludedCount} excluded folder${excludedCount > 1 ? 's' : ''}`;
    }
  }

  private openSelectiveSyncModal(): void {
    void import('./SelectiveSyncModal').then(({ SelectiveSyncModal }) => {
      const pluginExt = this.plugin as unknown as PluginWithServices;

      if (pluginExt.syncService) {
        const selectiveSyncService = pluginExt.syncService.getSelectiveSyncService();
        new SelectiveSyncModal(
          this.app,
          selectiveSyncService,
          () => {
            void (async () => {
              const config = selectiveSyncService.getConfig();
              this.plugin.settings.includedFolders = config.includedFolders;
              this.plugin.settings.excludedFolders = config.excludedFolders;
              await this.plugin.saveSettings();
              this.display();
            })();
          }
        ).open();
      } else {
        void import('../services/SelectiveSyncService').then(({ SelectiveSyncService }) => {
          void import('../core/EventBus').then(({ EventBus }) => {
            void import('../core/StorageManager').then(({ StorageManager }) => {
              const eventBus = new EventBus();
              const storage = new StorageManager(this.plugin);
              const selectiveSyncService = new SelectiveSyncService(
                eventBus,
                storage,
                {
                  includedFolders: this.plugin.settings.includedFolders,
                  excludedFolders: this.plugin.settings.excludedFolders
                },
                this.app.vault.configDir
              );

              new SelectiveSyncModal(
                this.app,
                selectiveSyncService,
                () => {
                  void (async () => {
                    const config = selectiveSyncService.getConfig();
                    this.plugin.settings.includedFolders = config.includedFolders;
                    this.plugin.settings.excludedFolders = config.excludedFolders;
                    await this.plugin.saveSettings();
                    this.display();
                  })();
                }
              ).open();
            });
          });
        });
      }
    });
  }

  private displayCollaborationSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Collaboration').setHeading();

    new Setting(containerEl)
      .setName('Enable collaboration')
      .setDesc('Enable real-time collaborative editing')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.collaborationEnabled)
          .onChange(async (value) => {
            this.plugin.settings.collaborationEnabled = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Show presence')
      .setDesc('Show active users and their current files')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.showPresence)
          .onChange(async (value) => {
            this.plugin.settings.showPresence = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Show cursors')
      .setDesc('Show cursor positions of other users')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.showCursors)
          .onChange(async (value) => {
            this.plugin.settings.showCursors = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Show typing indicators')
      .setDesc('Show when other users are typing')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.showTypingIndicators)
          .onChange(async (value) => {
            this.plugin.settings.showTypingIndicators = value;
            await this.plugin.saveSettings();
          });
      });
  }

  private displayNotificationSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Notifications').setHeading();

    new Setting(containerEl)
      .setName('Sync notifications')
      .setDesc('Show notifications when files are synced')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.notifyOnSync)
          .onChange(async (value) => {
            this.plugin.settings.notifyOnSync = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Conflict notifications')
      .setDesc('Show notifications when conflicts are detected')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.notifyOnConflict)
          .onChange(async (value) => {
            this.plugin.settings.notifyOnConflict = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Collaborator notifications')
      .setDesc('Show notifications when collaborators join or leave')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.notifyOnCollaboratorJoin)
          .onChange(async (value) => {
            this.plugin.settings.notifyOnCollaboratorJoin = value;
            await this.plugin.saveSettings();
          });
      });
  }

  private displayPerformanceSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Performance').setHeading();

    new Setting(containerEl)
      .setName('Max concurrent uploads')
      .setDesc('Maximum number of files to upload simultaneously (1-10)')
      .addText(text => {
        this.addNumberValidation(text,
          this.plugin.settings.maxConcurrentUploads,
          async (value) => {
            if (value >= 1 && value <= 10) {
              this.plugin.settings.maxConcurrentUploads = value;
              await this.plugin.saveSettings();
              return true;
            }
            return false;
          },
          'Must be between 1 and 10'
        );
        text.inputEl.type = 'number';
      });

    new Setting(containerEl)
      .setName('Chunk size')
      .setDesc('File chunk size in megabytes for large uploads (1 to 10)')
      .addText(text => {
        const chunkSizeMB = Math.round(this.plugin.settings.chunkSize / 1048576);
        this.addNumberValidation(text,
          chunkSizeMB,
          async (value) => {
            if (value >= 1 && value <= 10) {
              this.plugin.settings.chunkSize = value * 1048576;
              await this.plugin.saveSettings();
              return true;
            }
            return false;
          },
          'Must be between 1 and 10 MB'
        );
        text.inputEl.type = 'number';
      });

    new Setting(containerEl)
      .setName('Enable caching')
      .setDesc('Cache vault metadata and file lists for better performance')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.cacheEnabled)
          .onChange(async (value) => {
            this.plugin.settings.cacheEnabled = value;
            await this.plugin.saveSettings();

            const pluginExt = this.plugin as unknown as PluginWithServices;
            if (!value && pluginExt.cacheService) {
              pluginExt.cacheService.clearAll();
              new Notice('Cache cleared');
            }
          });
      });
  }

  private displayAdvancedSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Advanced').setHeading();

    const warningEl = containerEl.createDiv({ cls: 'vaultsync-warning' });
    warningEl.createEl('p', {
      text: 'Changing these settings may affect plugin functionality. Only modify if you know what you\'re doing.',
      cls: 'setting-item-description'
    });

    // Server URL (user-facing)
    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('The URL you entered during setup')
      .addText(text => {
        text
          .setPlaceholder('https://app.vaultsync.morinclan.com')
          .setValue(this.plugin.settings.serverUrl || '')
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });

    // API Base URL
    new Setting(containerEl)
      .setName('API base URL')
      .setDesc('API server URL (requires reconnection)')
      .addText(text => {
        this.addUrlValidation(text,
          this.plugin.settings.apiBaseURL,
          async (value) => {
            this.plugin.settings.apiBaseURL = value.trim();
            this.plugin.settings.apiUrl = value.trim();
            await this.plugin.saveSettings();
            new Notice('API URL updated. Please reconnect to apply changes.');
            return true;
          }
        );
      });

    // WebSocket Base URL
    new Setting(containerEl)
      .setName('Websocket base URL')
      .setDesc('Websocket server URL (requires reconnection)')
      .addText(text => {
        this.addUrlValidation(text,
          this.plugin.settings.wsBaseURL,
          async (value) => {
            this.plugin.settings.wsBaseURL = value.trim();
            this.plugin.settings.wsUrl = value.trim();
            await this.plugin.saveSettings();
            new Notice('Websocket URL updated. Please reconnect to apply changes.');
            return true;
          }
        );
      });

    // Device ID (read-only)
    new Setting(containerEl)
      .setName('Device ID')
      .setDesc('Unique identifier for this device (read-only)')
      .addText(text => {
        text.setValue(this.plugin.settings.deviceId);
        text.inputEl.disabled = true;
        text.inputEl.addClass('vaultconnect-input-disabled');
      });

    // Initial Sync State Reset
    this.displayInitialSyncReset(containerEl);

    // Debug mode
    new Setting(containerEl)
      .setName('Debug mode')
      .setDesc('Enable verbose logging for troubleshooting (check console)')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.debugMode)
          .onChange(async (value) => {
            this.plugin.settings.debugMode = value;
            await this.plugin.saveSettings();
            new Notice(`Debug mode ${value ? 'enabled' : 'disabled'}`);
          });
      });

    // Export/Import/Reset at bottom of Advanced
    const actionsEl = containerEl.createDiv({ cls: 'vaultsync-settings-actions' });

    actionsEl.createEl('button', {
      text: 'Export settings',
      cls: 'mod-cta'
    }).addEventListener('click', () => void this.exportSettings());

    actionsEl.createEl('button', {
      text: 'Import settings',
      cls: 'mod-cta'
    }).addEventListener('click', () => void this.importSettings());

    actionsEl.createEl('button', {
      text: 'Reset to defaults',
      cls: 'mod-warning'
    }).addEventListener('click', () => void this.resetSettings());
  }

  private displayInitialSyncReset(containerEl: HTMLElement): void {
    const vaultId = this.plugin.settings.selectedVaultId || this.plugin.settings.vaultId;

    if (!vaultId) return;

    const initialSyncService = this.plugin.initialSyncService;
    if (!initialSyncService) return;

    initialSyncService.getSyncState(vaultId).then((syncState: InitialSyncState | null) => {
      let description = 'Reset initial sync state for troubleshooting';

      if (syncState && syncState.completed) {
        const completedDate = syncState.completedAt ? new Date(syncState.completedAt) : new Date();
        const dateStr = completedDate.toLocaleDateString();
        const timeStr = completedDate.toLocaleTimeString();

        const optionLabels: Record<string, string> = {
          'start-fresh': 'Start fresh',
          'upload-local': 'Upload local',
          'smart-merge': 'Smart merge'
        };
        const optionLabel = syncState.chosenOption ? (optionLabels[syncState.chosenOption] || syncState.chosenOption) : 'Unknown';

        description = `Completed on ${dateStr} at ${timeStr} using "${optionLabel}" option. Reset to run initial sync wizard again.`;
      } else {
        description = 'No initial sync completed yet. Reset will clear any partial sync state.';
      }

      new Setting(containerEl)
        .setName('Reset initial sync')
        .setDesc(description)
        .addButton(button => {
          button
            .setButtonText('Reset')
            .setWarning()
            .onClick(async () => {
              await this.resetInitialSyncState(vaultId, initialSyncService);
            });
        });
    }).catch((error: Error) => {
      console.error('Failed to get sync state:', error);

      new Setting(containerEl)
        .setName('Reset initial sync')
        .setDesc('Reset initial sync state for troubleshooting')
        .addButton(button => {
          button
            .setButtonText('Reset')
            .setWarning()
            .onClick(async () => {
              await this.resetInitialSyncState(vaultId, initialSyncService);
            });
        });
    });
  }

  private async resetInitialSyncState(vaultId: string, initialSyncService: InitialSyncService): Promise<void> {
    let syncState: InitialSyncState | null = null;
    try {
      syncState = await initialSyncService.getSyncState(vaultId);
    } catch (error) {
      console.error('Failed to get sync state:', error);
    }

    let confirmMessage = 'Are you sure you want to reset the initial sync state?\n\n';

    if (syncState && syncState.completed) {
      const optionLabels: Record<string, string> = {
        'start-fresh': 'Start fresh',
        'upload-local': 'Upload local',
        'smart-merge': 'Smart merge'
      };
      const optionLabel = syncState.chosenOption ? (optionLabels[syncState.chosenOption] || syncState.chosenOption) : 'Unknown';

      confirmMessage += `Current state:\n`;
      confirmMessage += `- Option: ${optionLabel}\n`;
      confirmMessage += `- Completed: ${syncState.completedAt ? new Date(syncState.completedAt).toLocaleString() : 'Unknown'}\n`;
      confirmMessage += `- Files processed: ${syncState.fileCounts.localOnly + syncState.fileCounts.remoteOnly + syncState.fileCounts.both}\n\n`;
    }

    confirmMessage += 'This will:\n';
    confirmMessage += '• Clear the initial sync completion status\n';
    confirmMessage += '• Show the initial sync wizard on next connection\n';
    confirmMessage += '• Not affect your current files or sync settings\n\n';
    confirmMessage += 'This is useful for testing or if you want to re-run the initial sync setup.';

    const confirmed = await showConfirmationModal(
      this.app,
      confirmMessage,
      { title: 'Reset initial sync state', confirmText: 'Reset', confirmClass: 'mod-warning' }
    );

    if (!confirmed) return;

    try {
      await initialSyncService.resetSyncState(vaultId);
      new Notice('Initial sync state reset successfully. The wizard will appear on next connection.');
      this.display();
    } catch (error) {
      console.error('Failed to reset initial sync state:', error);
      new Notice('Failed to reset initial sync state. Check console for details.');
    }
  }

  // ===========================================================================
  // Validation helpers
  // ===========================================================================

  private addNumberValidation(
    text: TextComponent,
    initialValue: number,
    onChange: (value: number) => Promise<boolean>,
    errorMessage: string
  ): void {
    text
      .setPlaceholder(String(initialValue))
      .setValue(String(initialValue))
      .onChange(async (value) => {
        const num = parseInt(value);
        if (isNaN(num)) {
          text.inputEl.addClass('vaultconnect-input-error');
          return;
        }

        const success = await onChange(num);
        if (success) {
          text.inputEl.removeClass('vaultconnect-input-error');
        } else {
          text.inputEl.addClass('vaultconnect-input-error');
          new Notice(errorMessage);
        }
      });
  }

  private addUrlValidation(
    text: TextComponent,
    initialValue: string,
    onChange: (value: string) => Promise<boolean>
  ): void {
    text
      .setPlaceholder('https://api.example.com')
      .setValue(initialValue)
      .onChange(async (value) => {
        const trimmed = value.trim();

        if (trimmed && !this.isValidUrl(trimmed)) {
          text.inputEl.addClass('vaultconnect-input-error');
          new Notice('Invalid URL format');
          return;
        }

        const success = await onChange(trimmed);
        if (success) {
          text.inputEl.removeClass('vaultconnect-input-error');
        } else {
          text.inputEl.addClass('vaultconnect-input-error');
        }
      });
  }

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // Settings import/export/reset
  // ===========================================================================

  private exportSettings(): void {
    try {
      const pluginExt = this.plugin as unknown as PluginWithServices;

      let json: string;

      if (pluginExt.settingsManager) {
        json = pluginExt.settingsManager.exportSettings();
      } else {
        const exportData: Partial<PluginSettings> = {
          syncMode: this.plugin.settings.syncMode,
          autoSync: this.plugin.settings.autoSync,
          syncInterval: this.plugin.settings.syncInterval,
          includedFolders: this.plugin.settings.includedFolders,
          excludedFolders: this.plugin.settings.excludedFolders,
          collaborationEnabled: this.plugin.settings.collaborationEnabled,
          showPresence: this.plugin.settings.showPresence,
          showCursors: this.plugin.settings.showCursors,
          showTypingIndicators: this.plugin.settings.showTypingIndicators,
          notifyOnSync: this.plugin.settings.notifyOnSync,
          notifyOnConflict: this.plugin.settings.notifyOnConflict,
          notifyOnCollaboratorJoin: this.plugin.settings.notifyOnCollaboratorJoin,
          maxConcurrentUploads: this.plugin.settings.maxConcurrentUploads,
          chunkSize: this.plugin.settings.chunkSize,
          cacheEnabled: this.plugin.settings.cacheEnabled,
          apiBaseURL: this.plugin.settings.apiBaseURL,
          wsBaseURL: this.plugin.settings.wsBaseURL,
          debugMode: this.plugin.settings.debugMode
        };
        json = JSON.stringify(exportData, null, 2);
      }

      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `vaultsync-settings-${Date.now()}.json`;
      a.click();

      URL.revokeObjectURL(url);
      new Notice('Settings exported successfully');
    } catch (error) {
      console.error('Failed to export settings:', error);
      new Notice('Failed to export settings');
    }
  }

  private importSettings(): void {
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json';

      input.onchange = async (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        const text = await file.text();

        const pluginExt = this.plugin as unknown as PluginWithServices;

        if (pluginExt.settingsManager) {
          const success = await pluginExt.settingsManager.importSettings(text);
          if (success) {
            this.display();
            new Notice('Settings imported successfully');
          } else {
            new Notice('Invalid settings file');
          }
        } else {
          const importedSettings = JSON.parse(text);

          if (!this.validateImportedSettings(importedSettings)) {
            new Notice('Invalid settings file');
            return;
          }

          Object.assign(this.plugin.settings, importedSettings);
          await this.plugin.saveSettings();
          this.display();
          new Notice('Settings imported successfully');
        }
      };

      input.click();
    } catch (error) {
      console.error('Failed to import settings:', error);
      new Notice('Failed to import settings');
    }
  }

  private validateImportedSettings(settings: unknown): boolean {
    if (typeof settings !== 'object' || settings === null) {
      return false;
    }

    const settingsObj = settings as Record<string, unknown>;

    if (settingsObj.syncMode && !Object.values(SyncMode).includes(settingsObj.syncMode as SyncMode)) {
      return false;
    }

    if (settingsObj.includedFolders && !Array.isArray(settingsObj.includedFolders)) {
      return false;
    }
    if (settingsObj.excludedFolders && !Array.isArray(settingsObj.excludedFolders)) {
      return false;
    }

    if (settingsObj.syncInterval !== undefined && (typeof settingsObj.syncInterval !== 'number' || settingsObj.syncInterval <= 0)) {
      return false;
    }
    if (settingsObj.maxConcurrentUploads !== undefined && (typeof settingsObj.maxConcurrentUploads !== 'number' || settingsObj.maxConcurrentUploads < 1)) {
      return false;
    }

    return true;
  }

  private async resetSettings(): Promise<void> {
    const confirmed = await showConfirmationModal(
      this.app,
      'Are you sure you want to reset all settings to defaults? This will preserve your authentication, server URL, and device ID.',
      { title: 'Reset settings', confirmText: 'Reset', confirmClass: 'mod-warning' }
    );

    if (!confirmed) return;

    try {
      const pluginExt = this.plugin as unknown as PluginWithServices;

      if (pluginExt.settingsManager) {
        await pluginExt.settingsManager.resetSettings();
      } else {
        const { DEFAULT_SETTINGS } = await import('../utils/constants');

        const apiKey = this.plugin.settings.apiKey;
        const apiKeyExpires = this.plugin.settings.apiKeyExpires;
        const selectedVaultId = this.plugin.settings.selectedVaultId;
        const vaultId = this.plugin.settings.vaultId;
        const deviceId = this.plugin.settings.deviceId;
        const serverUrl = this.plugin.settings.serverUrl;
        const apiBaseURL = this.plugin.settings.apiBaseURL;
        const apiUrl = this.plugin.settings.apiUrl;
        const wsBaseURL = this.plugin.settings.wsBaseURL;
        const wsUrl = this.plugin.settings.wsUrl;

        Object.assign(this.plugin.settings, DEFAULT_SETTINGS);

        this.plugin.settings.apiKey = apiKey;
        this.plugin.settings.apiKeyExpires = apiKeyExpires;
        this.plugin.settings.selectedVaultId = selectedVaultId;
        this.plugin.settings.vaultId = vaultId;
        this.plugin.settings.deviceId = deviceId;
        this.plugin.settings.serverUrl = serverUrl;
        this.plugin.settings.apiBaseURL = apiBaseURL;
        this.plugin.settings.apiUrl = apiUrl;
        this.plugin.settings.wsBaseURL = wsBaseURL;
        this.plugin.settings.wsUrl = wsUrl;

        await this.plugin.saveSettings();
      }

      this.display();
      new Notice('Settings reset to defaults');
    } catch (error) {
      console.error('Failed to reset settings:', error);
      new Notice('Failed to reset settings');
    }
  }
}
