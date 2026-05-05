import { App, PluginSettingTab, Setting, Notice, TextComponent, DropdownComponent } from 'obsidian';
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
    containerEl.addClass('vaultconnect-settings');

    // Pause sync while settings are open
    this.plugin.syncPaused = true;

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

  hide(): void {
    // Resume sync when settings are closed
    this.plugin.syncPaused = false;
  }

  // ===========================================================================
  // Stage: NEEDS_SERVER
  // ===========================================================================

  private displayServerStage(containerEl: HTMLElement): void {
    this.displayStepIndicator(containerEl, 1);

    new Setting(containerEl)
      .setName('Welcome to VaultConnect')
      .setDesc('Enter your VaultConnect server URL to get started.')
      .setHeading();

    let serverUrlInput: TextComponent;

    const urlSetting = new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Your VaultConnect web or API URL')
      .addText(text => {
        serverUrlInput = text;
        text
          .setPlaceholder('https://app.vaultsync.morinclan.com')
          .setValue(this.plugin.settings.serverUrl || '');
        text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            void this.handleServerConnect(serverUrlInput.getValue(), containerEl);
          }
        });
      })
      .addButton(button => {
        button
          .setButtonText('Connect')
          .setCta()
          .onClick(() => {
            void this.handleServerConnect(serverUrlInput.getValue(), containerEl);
          });
      });

    // Auto-discover if serverUrl is already set (e.g., returning from "Change")
    if (this.plugin.settings.serverUrl) {
      setTimeout(() => {
        void this.handleServerConnect(serverUrlInput.getValue(), containerEl);
      }, 100);
    }
  }

  private async handleServerConnect(
    url: string,
    containerEl: HTMLElement
  ): Promise<void> {
    if (!url.trim()) {
      new Notice('Please enter a server URL');
      return;
    }

    new Notice('Discovering server configuration...');

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

      new Notice(`Connected to VaultConnect ${config.version}`);

      // Short delay then refresh to next stage
      setTimeout(() => this.display(), 500);
    } catch (error) {
      new Notice(error.message || 'Failed to discover server');

      // Show manual fallback
      this.displayManualFallback(containerEl);
    }
  }

  private displayManualFallback(containerEl: HTMLElement): void {
    // Check if fallback already shown
    if (containerEl.querySelector('.vaultconnect-manual-fallback')) return;

    const fallback = containerEl.createDiv({ cls: 'vaultconnect-manual-fallback' });
    const details = fallback.createEl('details');
    details.createEl('summary', { text: 'Manual configuration' });
    const content = details.createDiv({ cls: 'vaultconnect-manual-fields' });

    let apiUrlText: TextComponent;
    let wsUrlText: TextComponent;

    new Setting(content)
      .setName('API URL')
      .setDesc('Direct API server URL')
      .addText(text => {
        apiUrlText = text;
        text
          .setPlaceholder('https://api.vaultsync.morinclan.com/v1')
          .setValue(this.plugin.settings.apiBaseURL || '');
      });

    new Setting(content)
      .setName('WebSocket URL')
      .setDesc('WebSocket server URL')
      .addText(text => {
        wsUrlText = text;
        text
          .setPlaceholder('https://api.vaultsync.morinclan.com')
          .setValue(this.plugin.settings.wsBaseURL || '');
      });

    new Setting(content)
      .addButton(button => {
        button
          .setButtonText('Save & continue')
          .setCta()
          .onClick(() => {
            const apiUrl = apiUrlText.getValue().trim();
            const wsUrl = wsUrlText.getValue().trim();

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
      });
  }

  // ===========================================================================
  // Stage: NEEDS_AUTH
  // ===========================================================================

  private displayAuthStage(containerEl: HTMLElement): void {
    this.displayStepIndicator(containerEl, 2);

    new Setting(containerEl)
      .setName('Sign in')
      .setHeading();

    const serverLabel = this.plugin.settings.serverUrl || this.plugin.settings.apiBaseURL;
    const versionText = this.cachedServerConfig?.version ? ` (v${this.cachedServerConfig.version})` : '';

    new Setting(containerEl)
      .setName('Server')
      .setDesc(serverLabel + versionText)
      .addButton(button => {
        button
          .setButtonText('Change')
          .onClick(() => {
            this.plugin.settings.apiBaseURL = '';
            this.plugin.settings.apiUrl = '';
            this.plugin.settings.wsBaseURL = '';
            this.plugin.settings.wsUrl = '';
            void (async () => {
              await this.plugin.saveSettings();
              this.display();
            })();
          });
      });

    const authDesc = this.cachedServerConfig?.googleOAuthEnabled
      ? 'Sign in via your browser. Google sign-in is available.'
      : 'Sign in via your browser to connect your account.';

    new Setting(containerEl)
      .setName('Authentication')
      .setDesc(authDesc)
      .addButton(button => {
        button
          .setButtonText('Sign in with browser')
          .setCta()
          .onClick(() => {
            if (!this.plugin.authService) {
              new Notice('Auth service not available');
              return;
            }

            new DeviceAuthModal(
              this.app,
              this.plugin.authService,
              this.plugin.settings.apiBaseURL,
              () => {
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
      });
  }

  // ===========================================================================
  // Stage: NEEDS_VAULT
  // ===========================================================================

  private displayVaultStage(containerEl: HTMLElement): void {
    this.displayStepIndicator(containerEl, 3);

    new Setting(containerEl)
      .setName('Select a vault')
      .setDesc('Choose which vault to sync with this Obsidian vault.')
      .setHeading();

    new Setting(containerEl)
      .setName('Signed in')
      .addButton(button => {
        button
          .setButtonText('Sign out')
          .setWarning()
          .onClick(() => {
            if (this.plugin.authService) {
              void this.plugin.authService.clearApiKey().then(() => {
                this.plugin.settings.apiKey = null;
                this.plugin.settings.apiKeyExpires = null;
                void this.plugin.saveSettings().then(() => this.display());
              });
            }
          });
      });

    // Vault list - use Setting items for each vault
    void this.loadVaultsForPicker(containerEl);
  }

  private async loadVaultsForPicker(containerEl: HTMLElement): Promise<void> {
    try {
      const vaults = await this.plugin.apiClient?.listVaults();

      if (!vaults || vaults.length === 0) {
        new Setting(containerEl)
          .setName('No vaults found')
          .setDesc('Create a vault in the VaultConnect web UI first.');
        return;
      }

      for (const vault of vaults) {
        const desc = `${vault.file_count || 0} files${vault.is_cross_tenant ? ' (Shared)' : ''}`;

        new Setting(containerEl)
          .setName(vault.name)
          .setDesc(desc)
          .addButton(button => {
            button
              .setButtonText('Select')
              .setCta()
              .onClick(() => {
                void this.selectVaultAndFinish(vault);
              });
          });
      }

      new Setting(containerEl)
        .addButton(button => {
          button
            .setButtonText('Refresh list')
            .onClick(() => {
              this.display();
            });
        });
    } catch (error) {
      new Setting(containerEl)
        .setName('Error')
        .setDesc(`Failed to load vaults: ${error.message}`);
    }
  }

  private async selectVaultAndFinish(vault: VaultInfo): Promise<void> {
    this.plugin.settings.selectedVaultId = vault.vault_id;
    this.plugin.settings.vaultId = vault.vault_id;
    await this.plugin.saveSettings();

    new Notice(`Vault "${vault.name}" selected! Connecting...`);

    try {
      await this.plugin.connect();
    } catch (error) {
      logger.warn('Auto-connect after vault selection failed:', error);
    }

    this.display();
  }

  // ===========================================================================
  // Stage: COMPLETE
  // ===========================================================================

  private displayCompleteStage(containerEl: HTMLElement): void {
    this.displayConnectionHeader(containerEl);
    this.displaySyncActions(containerEl);
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

    const statusDesc = isAuthed ? 'Signed in' : 'Not signed in';
    const vaultName = vaultId ? vaultId.substring(0, 8) + '...' : 'None';

    new Setting(containerEl)
      .setName('Status')
      .setDesc(`${statusDesc} | Vault: ${vaultName}`)
      .addButton(button => {
        if (isAuthed) {
          button
            .setButtonText('Sign out')
            .setWarning()
            .onClick(async () => {
              if (this.plugin.authService) {
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

    if (isAuthed && vaultId) {
      new Setting(containerEl)
        .setName('Connection')
        .setDesc(this.plugin.isConnected ? 'Connected to server' : 'Not connected')
        .addButton(button => {
          if (this.plugin.isConnected) {
            button
              .setButtonText('Disconnect')
              .onClick(() => {
                this.plugin.disconnect();
                this.display();
              });
          } else {
            button
              .setButtonText('Connect')
              .setCta()
              .onClick(async () => {
                await this.plugin.connect();
                this.display();
              });
          }
        });
    }

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

    this.displayVaultSelector(containerEl);
  }

  private displayVaultSelector(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Vault selection').setHeading();

    let dropdownComponent: DropdownComponent = null as any;

    new Setting(containerEl)
      .setName('Vault')
      .setDesc('Select the vault to sync with')
      .addDropdown(dropdown => {
        dropdownComponent = dropdown;
        dropdown.addOption('', 'Loading...');
        dropdown.setDisabled(true);
        dropdown.onChange(async (value) => {
          if (value) {
            this.plugin.settings.selectedVaultId = value;
            this.plugin.settings.vaultId = value;
            await this.plugin.saveSettings();
            new Notice('Vault selected. Disconnect and reconnect to sync with this vault.');
          }
        });
      })
      .addButton(button => {
        button
          .setButtonText('Refresh')
          .onClick(() => { void loadVaults(); });
      });

    const loadVaults = async () => {
      if (!this.plugin.settings.apiKey && !this.plugin.authService?.isAuthenticated()) {
        dropdownComponent.selectEl.empty();
        dropdownComponent.addOption('', 'Sign in first');
        dropdownComponent.setDisabled(true);
        return;
      }

      try {
        dropdownComponent.setDisabled(true);

        const vaults = await this.plugin.apiClient?.listVaults();

        dropdownComponent.selectEl.empty();

        if (!vaults || vaults.length === 0) {
          dropdownComponent.addOption('', 'No vaults found');
        } else {
          dropdownComponent.addOption('', 'Select a vault...');

          const currentVaultId = this.plugin.settings.selectedVaultId || this.plugin.settings.vaultId;

          vaults.forEach((vault: VaultInfo) => {
            dropdownComponent.addOption(
              vault.vault_id,
              `${vault.name} (${vault.file_count || 0} files)`
            );
            if (vault.vault_id === currentVaultId) {
              dropdownComponent.setValue(currentVaultId);
            }
          });
        }

        dropdownComponent.setDisabled(false);
      } catch (error) {
        logger.error('Failed to load vaults:', error);
        dropdownComponent.selectEl.empty();
        dropdownComponent.addOption('', 'Error loading vaults');
      }
    };

    if (this.plugin.settings.apiKey || this.plugin.authService?.isAuthenticated()) {
      void loadVaults();
    } else {
      dropdownComponent.selectEl.empty();
      dropdownComponent.addOption('', 'Sign in first');
      dropdownComponent.setDisabled(true);
    }

    // Cross-tenant vault status
    const currentVaultId = this.plugin.settings.selectedVaultId || this.plugin.settings.vaultId;
    if (this.plugin.vaultService && currentVaultId) {
      const vault = this.plugin.vaultService.getCurrentVault();
      if (vault?.is_cross_tenant) {
        const permissionLabel = vault.permission === 'read' ? 'Read-only' : vault.permission === 'write' ? 'Read-write' : 'Admin';
        new Setting(containerEl)
          .setName('Shared vault')
          .setDesc(`Cross-tenant vault (${permissionLabel})`);
      }
    }

    new Setting(containerEl)
      .setName('Device ID')
      .setDesc('Unique identifier for this device')
      .addText(text => {
        text.setValue(this.plugin.settings.deviceId);
        text.setDisabled(true);
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
  // Sync action buttons
  // ===========================================================================

  private displaySyncActions(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Sync actions').setHeading();

    const isConnected = this.plugin.isConnected;

    if (!isConnected) {
      new Setting(containerEl)
        .setDesc('Connect to the server first to use sync actions.');
      return;
    }

    // Note: sync is paused while settings are open — these buttons override that
    new Setting(containerEl)
      .setDesc('Sync is paused while settings are open. Use these buttons to sync manually.')
      .addButton(button => {
        button
          .setButtonText('Push all')
          .setCta()
          .onClick(async () => {
            button.setButtonText('Pushing...');
            button.setDisabled(true);
            this.plugin.syncPaused = false;
            try {
              await this.plugin.performPushAll();
            } finally {
              this.plugin.syncPaused = true;
              button.setButtonText('Push all');
              button.setDisabled(false);
            }
          });
      })
      .addButton(button => {
        button
          .setButtonText('Pull all')
          .onClick(async () => {
            button.setButtonText('Pulling...');
            button.setDisabled(true);
            this.plugin.syncPaused = false;
            try {
              await this.plugin.performPullAll();
            } finally {
              this.plugin.syncPaused = true;
              button.setButtonText('Pull all');
              button.setDisabled(false);
            }
          });
      })
      .addButton(button => {
        button
          .setButtonText('Force sync')
          .onClick(async () => {
            button.setButtonText('Syncing...');
            button.setDisabled(true);
            this.plugin.syncPaused = false;
            try {
              await this.plugin.performForceSync();
            } finally {
              this.plugin.syncPaused = true;
              button.setButtonText('Force sync');
              button.setDisabled(false);
            }
          });
      })
      .addButton(button => {
        button
          .setButtonText('Reconcile from server')
          .setTooltip('Pull every file the server has — including ones this device previously deleted. Use when files exist on server but Force Sync will not bring them down.')
          .onClick(async () => {
            button.setButtonText('Reconciling...');
            button.setDisabled(true);
            this.plugin.syncPaused = false;
            try {
              await this.plugin.performReconcileFromServer();
            } finally {
              this.plugin.syncPaused = true;
              button.setButtonText('Reconcile from server');
              button.setDisabled(false);
            }
          });
      });
  }

  // Full settings sections (shown in COMPLETE stage)
  // ===========================================================================

  private displaySyncSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Sync').setHeading();

    new Setting(containerEl)
      .setName('Sync mode')
      .setDesc(this.getSyncModeDescription(this.plugin.settings.syncMode))
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
            new Notice(`Sync mode changed to ${this.getSyncModeLabel(value as SyncMode)}`);
            this.display();
          });
      });

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

  private getSyncModeDescription(mode: SyncMode): string {
    const descriptions: Record<string, string> = {
      [SyncMode.SMART_SYNC]: 'Bidirectional sync with automatic conflict detection.',
      [SyncMode.PULL_ALL]: 'Download all remote files. Local changes preserved as conflict copies.',
      [SyncMode.PUSH_ALL]: 'Upload all local files. Remote versions are overwritten.',
      [SyncMode.MANUAL]: 'No automatic sync. Use commands to manually sync.'
    };
    return descriptions[mode] || '';
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
      .addText(text => {
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
      });

    const includedFolders = this.plugin.settings.includedFolders;
    const includedDisplay = includedFolders.length > 0
      ? includedFolders.slice(0, 3).join(', ') + (includedFolders.length > 3 ? '...' : '')
      : 'All (except excluded)';

    new Setting(containerEl)
      .setName('Included folders')
      .setDesc(includedDisplay)
      .addText(text => {
        text
          .setPlaceholder('notes/, docs/')
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
    new Setting(containerEl)
      .setName('Advanced')
      .setDesc('Changing these settings may affect plugin functionality.')
      .setHeading();

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

    new Setting(containerEl)
      .setName('Device ID')
      .setDesc('Unique identifier for this device (read-only)')
      .addText(text => {
        text.setValue(this.plugin.settings.deviceId);
        text.setDisabled(true);
      });

    this.displayInitialSyncReset(containerEl);

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

    new Setting(containerEl)
      .setName('Export settings')
      .setDesc('Save current settings to a file')
      .addButton(button => {
        button
          .setButtonText('Export')
          .onClick(() => void this.exportSettings());
      });

    new Setting(containerEl)
      .setName('Import settings')
      .setDesc('Load settings from a file')
      .addButton(button => {
        button
          .setButtonText('Import')
          .onClick(() => void this.importSettings());
      });

    new Setting(containerEl)
      .setName('Reset to defaults')
      .setDesc('Reset all settings (preserves auth and server URL)')
      .addButton(button => {
        button
          .setButtonText('Reset')
          .setWarning()
          .onClick(() => void this.resetSettings());
      });
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

        description = `Completed ${dateStr} at ${timeStr} using "${optionLabel}". Reset to run wizard again.`;
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
