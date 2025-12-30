import { App, PluginSettingTab, Setting, Notice, TextComponent } from 'obsidian';
import VaultSyncPlugin from '../../main';
import { DeviceAuthModal } from './DeviceAuthModal';
import { showConfirmationModal } from './ConfirmationModal';
import { formatRelativeTime } from '../utils/helpers';
import { SyncMode, PluginSettings } from '../types';

/**
 * Settings Tab for VaultSync Plugin
 * Provides comprehensive configuration UI with validation and help text
 */
export class VaultSyncSettingTab extends PluginSettingTab {
  plugin: VaultSyncPlugin;

  constructor(app: App, plugin: VaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Header with title and actions
    const headerEl = containerEl.createDiv({ cls: 'vaultsync-settings-header' });
    headerEl.createEl('h2', { text: 'VaultSync Settings' });
    
    // Settings actions
    const actionsEl = headerEl.createDiv({ cls: 'vaultsync-settings-actions' });
    
    // Export settings button
    actionsEl.createEl('button', {
      text: 'Export settings',
      cls: 'mod-cta'
    }).addEventListener('click', () => this.exportSettings());
    
    // Import settings button
    actionsEl.createEl('button', {
      text: 'Import settings',
      cls: 'mod-cta'
    }).addEventListener('click', () => this.importSettings());
    
    // Reset settings button
    actionsEl.createEl('button', {
      text: 'Reset to Defaults',
      cls: 'mod-warning'
    }).addEventListener('click', () => this.resetSettings());

    // Authentication Section
    this.displayAuthSection(containerEl);

    // Only show other settings if authenticated
    const authState = this.plugin.authService.getAuthState();
    if (authState.isAuthenticated) {
      this.displayVaultSection(containerEl);
      this.displaySyncSection(containerEl);
      this.displaySelectiveSyncSection(containerEl);
      this.displayCollaborationSection(containerEl);
      this.displayNotificationSection(containerEl);
      this.displayPerformanceSection(containerEl);
      this.displayAdvancedSection(containerEl);
    } else {
      const infoEl = containerEl.createDiv({ cls: 'vaultsync-auth-required' });
      infoEl.createEl('p', {
        text: '🔒 Please authenticate to access additional settings.',
        cls: 'setting-item-description'
      });
      infoEl.createEl('p', {
        text: 'Click the Login button above to connect your VaultSync account.',
        cls: 'setting-item-description'
      });
    }
  }

  private displayAuthSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Authentication' });

    const authState = this.plugin.authService.getAuthState();

    // Connection status
    new Setting(containerEl)
      .setName('Status')
      .setDesc(authState.isAuthenticated ? '🟢 Connected' : '⚫ Not connected')
      .addButton(button => {
        if (authState.isAuthenticated) {
          button
            .setButtonText('Logout')
            .setWarning()
            .onClick(async () => {
              await this.plugin.authService.clearApiKey();
              new Notice('Logged out successfully');
              this.display(); // Refresh settings
            });
        } else {
          button
            .setButtonText('Login')
            .setCta()
            .onClick(() => {
              new DeviceAuthModal(
                this.app,
                this.plugin.authService,
                this.plugin.settings.apiBaseURL,
                () => {
                  this.display(); // Refresh settings after login
                },
                () => {
                  // Cancelled
                }
              ).open();
            });
        }
      });

    // API Key info (if authenticated)
    if (authState.isAuthenticated && authState.apiKey) {
      const maskedKey = authState.apiKey.substring(0, 12) + '****' + authState.apiKey.substring(authState.apiKey.length - 4);
      
      new Setting(containerEl)
        .setName('API Key')
        .setDesc(maskedKey);

      // Expiration info
      if (authState.expiresAt) {
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
              setting.descEl.style.color = 'var(--text-error)';
            }
          });
      }
    }
  }

  private displayVaultSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Vault selection' });

    // Selected vault
    new Setting(containerEl)
      .setName('Selected vault')
      .setDesc('The VaultSync vault to sync with')
      .addText(text => {
        text
          .setPlaceholder('vault-id')
          .setValue(this.plugin.settings.selectedVaultId || '')
          .onChange(async (value) => {
            this.plugin.settings.selectedVaultId = value.trim() || null;
            await this.plugin.saveSettings();
          });
      })
      .addButton(button => {
        button
          .setButtonText('Browse')
          .onClick(async () => {
            // TODO: Implement vault browser
            new Notice('Vault browser coming soon!');
          });
      });

    // Cross-tenant vault status (if vault is selected)
    if (this.plugin.vaultService && this.plugin.settings.selectedVaultId) {
      const vault = this.plugin.vaultService.getCurrentVault();
      if (vault) {
        const statusEl = containerEl.createDiv({ cls: 'vaultsync-vault-status' });
        
        if (vault.is_cross_tenant) {
          const permissionIcon = vault.permission === 'read' ? '👁️' : vault.permission === 'write' ? '✏️' : '👑';
          const permissionLabel = vault.permission === 'read' ? 'Read-Only' : vault.permission === 'write' ? 'Read-Write' : 'Admin';
          
          statusEl.createEl('div', {
            text: `🔗 Cross-Tenant Vault (${permissionIcon} ${permissionLabel})`,
            cls: 'vaultsync-cross-tenant-badge'
          });
          
          const descEl = statusEl.createEl('p', {
            cls: 'setting-item-description'
          });
          
          if (vault.permission === 'read') {
            descEl.setText('⚠️ This vault is shared from another tenant with read-only access. You can download and view files, but uploads are disabled to prevent sync conflicts.');
          } else if (vault.permission === 'write') {
            descEl.setText('✅ This vault is shared from another tenant with write access. You can download, view, and upload files.');
          } else {
            descEl.setText('✅ You have full admin access to this cross-tenant vault.');
          }
        } else {
          statusEl.createEl('div', {
            text: '✅ Owned Vault',
            cls: 'vaultsync-owned-vault-badge'
          });
          statusEl.createEl('p', {
            text: 'This vault is owned by your tenant. You have full access.',
            cls: 'setting-item-description'
          });
        }
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

  private displaySyncSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Sync settings' });

    // Sync mode with detailed descriptions
    const syncModeDesc = containerEl.createDiv({ cls: 'vaultsync-sync-mode-desc' });
    
    new Setting(containerEl)
      .setName('Sync mode')
      .setDesc('Choose how files should be synchronized')
      .addDropdown(dropdown => {
        dropdown
          .addOption(SyncMode.SMART_SYNC, 'Smart Sync (recommended)')
          .addOption(SyncMode.PULL_ALL, 'Pull All')
          .addOption(SyncMode.PUSH_ALL, 'Push All')
          .addOption(SyncMode.MANUAL, 'Manual')
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            this.plugin.settings.syncMode = value as SyncMode;
            await this.plugin.saveSettings();
            this.updateSyncModeDescription(syncModeDesc, value as SyncMode);
            new Notice(`Sync mode changed to ${this.getSyncModeLabel(value as SyncMode)}`);
          });
      });
    
    // Show description for current mode
    this.updateSyncModeDescription(syncModeDesc, this.plugin.settings.syncMode);

    // Auto sync
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

    // Sync interval with validation
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
    
    const descriptions = {
      [SyncMode.SMART_SYNC]: '📊 Bidirectional sync with automatic conflict detection. Changes are synced both ways, and conflicts are detected before overwriting.',
      [SyncMode.PULL_ALL]: '⬇️ Download all remote files. Local changes are preserved as conflict copies if they differ from remote.',
      [SyncMode.PUSH_ALL]: '⬆️ Upload all local files. Remote versions are overwritten with local content.',
      [SyncMode.MANUAL]: '✋ No automatic sync. Use commands to manually sync files when needed.'
    };
    
    containerEl.createEl('p', {
      text: descriptions[mode],
      cls: 'setting-item-description vaultsync-mode-description'
    });
  }

  private getSyncModeLabel(mode: SyncMode): string {
    const labels = {
      [SyncMode.SMART_SYNC]: 'Smart Sync',
      [SyncMode.PULL_ALL]: 'Pull All',
      [SyncMode.PUSH_ALL]: 'Push All',
      [SyncMode.MANUAL]: 'Manual'
    };
    return labels[mode];
  }

  private displaySelectiveSyncSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Selective sync' });

    // Sync scope summary
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

    // Excluded folders (simplified view)
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
            
            // Update sync service if available
            if ((this.plugin as any).syncService) {
              (this.plugin as any).syncService.setExcludedFolders(this.plugin.settings.excludedFolders);
            }
          });
        text.inputEl.rows = 3;
      });

    // Included folders (simplified view)
    const includedFolders = this.plugin.settings.includedFolders;
    const includedDisplay = includedFolders.length > 0 
      ? includedFolders.slice(0, 3).join(', ') + (includedFolders.length > 3 ? '...' : '')
      : 'All (except excluded)';

    new Setting(containerEl)
      .setName('Included folders')
      .setDesc(includedDisplay)
      .addTextArea(text => {
        text
          .setPlaceholder('notes/, docs/')
          .setValue(this.plugin.settings.includedFolders.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.includedFolders = value
              .split(',')
              .map(f => f.trim())
              .filter(f => f.length > 0);
            await this.plugin.saveSettings();
            
            // Update sync service if available
            if ((this.plugin as any).syncService) {
              (this.plugin as any).syncService.setIncludedFolders(this.plugin.settings.includedFolders);
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
    // Import dynamically to avoid circular dependencies
    import('./SelectiveSyncModal').then(({ SelectiveSyncModal }) => {
      // Check if plugin has syncService (for full implementation)
      if ((this.plugin as any).syncService) {
        const selectiveSyncService = (this.plugin as any).syncService.getSelectiveSyncService();
        new SelectiveSyncModal(
          this.app,
          selectiveSyncService,
          async () => {
            // Save settings when modal closes
            const config = selectiveSyncService.getConfig();
            this.plugin.settings.includedFolders = config.includedFolders;
            this.plugin.settings.excludedFolders = config.excludedFolders;
            await this.plugin.saveSettings();
            
            // Refresh settings display
            this.display();
          }
        ).open();
      } else {
        // Fallback: Create a temporary SelectiveSyncService for configuration
        import('../services/SelectiveSyncService').then(({ SelectiveSyncService }) => {
          import('../core/EventBus').then(({ EventBus }) => {
            import('../core/StorageManager').then(({ StorageManager }) => {
              const eventBus = new EventBus();
              const storage = new StorageManager(this.plugin);
              const selectiveSyncService = new SelectiveSyncService(
                eventBus,
                storage,
                {
                  includedFolders: this.plugin.settings.includedFolders,
                  excludedFolders: this.plugin.settings.excludedFolders
                }
              );
              
              new SelectiveSyncModal(
                this.app,
                selectiveSyncService,
                async () => {
                  // Save settings when modal closes
                  const config = selectiveSyncService.getConfig();
                  this.plugin.settings.includedFolders = config.includedFolders;
                  this.plugin.settings.excludedFolders = config.excludedFolders;
                  await this.plugin.saveSettings();
                  
                  // Refresh settings display
                  this.display();
                }
              ).open();
            });
          });
        });
      }
    });
  }

  private displayCollaborationSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Collaboration' });

    // Enable collaboration
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

    // Show presence
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

    // Show cursors
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

    // Show typing indicators
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
    containerEl.createEl('h3', { text: 'Notifications' });

    // Notify on sync
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

    // Notify on conflict
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

    // Notify on collaborator join
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
    containerEl.createEl('h3', { text: 'Performance' });

    // Max concurrent uploads
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

    // Chunk size
    new Setting(containerEl)
      .setName('Chunk size')
      .setDesc('Size of file chunks for large file uploads (in MB, 1-10)')
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

    // Cache enabled
    new Setting(containerEl)
      .setName('Enable caching')
      .setDesc('Cache vault metadata and file lists for better performance')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.cacheEnabled)
          .onChange(async (value) => {
            this.plugin.settings.cacheEnabled = value;
            await this.plugin.saveSettings();
            
            if (!value && (this.plugin as any).cacheService) {
              // Clear cache when disabled
              await (this.plugin as any).cacheService.clearAll();
              new Notice('Cache cleared');
            }
          });
      });
  }

  private displayAdvancedSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Advanced' });

    // Warning message
    const warningEl = containerEl.createDiv({ cls: 'vaultsync-warning' });
    warningEl.createEl('p', {
      text: '⚠️ Changing these settings may affect plugin functionality. Only modify if you know what you\'re doing.',
      cls: 'setting-item-description'
    });

    // API Base URL
    new Setting(containerEl)
      .setName('API Base URL')
      .setDesc('VaultSync API server URL (requires reconnection)')
      .addText(text => {
        this.addUrlValidation(text,
          this.plugin.settings.apiBaseURL,
          async (value) => {
            this.plugin.settings.apiBaseURL = value.trim();
            await this.plugin.saveSettings();
            new Notice('API URL updated. Please reconnect to apply changes.');
            return true;
          }
        );
      });

    // WebSocket Base URL
    new Setting(containerEl)
      .setName('WebSocket Base URL')
      .setDesc('VaultSync WebSocket server URL (requires reconnection)')
      .addText(text => {
        this.addUrlValidation(text,
          this.plugin.settings.wsBaseURL,
          async (value) => {
            this.plugin.settings.wsBaseURL = value.trim();
            await this.plugin.saveSettings();
            new Notice('WebSocket URL updated. Please reconnect to apply changes.');
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
        text.inputEl.style.opacity = '0.6';
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
  }

  private displayInitialSyncReset(containerEl: HTMLElement): void {
    const vaultId = this.plugin.settings.selectedVaultId;
    
    if (!vaultId) {
      // No vault selected, don't show the reset option
      return;
    }

    // Get initial sync service
    const initialSyncService = (this.plugin as any).initialSyncService;
    
    if (!initialSyncService) {
      // Service not available
      return;
    }

    // Get sync state asynchronously and update UI
    initialSyncService.getSyncState(vaultId).then((syncState: any) => {
      let description = 'Reset initial sync state for troubleshooting';
      
      if (syncState && syncState.completed) {
        // Format the completion date
        const completedDate = new Date(syncState.completedAt);
        const dateStr = completedDate.toLocaleDateString();
        const timeStr = completedDate.toLocaleTimeString();
        
        // Get option label
        const optionLabels: Record<string, string> = {
          'start-fresh': 'Start Fresh',
          'upload-local': 'Upload Local',
          'smart-merge': 'Smart Merge'
        };
        const optionLabel = optionLabels[syncState.chosenOption] || syncState.chosenOption;
        
        description = `Completed on ${dateStr} at ${timeStr} using "${optionLabel}" option. Reset to run initial sync wizard again.`;
      } else {
        description = 'No initial sync completed yet. Reset will clear any partial sync state.';
      }

      // Create or update the setting
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
      
      // Show basic reset option even if we can't get state
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

  private async resetInitialSyncState(vaultId: string, initialSyncService: any): Promise<void> {
    // Get current sync state for confirmation message
    let syncState: any = null;
    try {
      syncState = await initialSyncService.getSyncState(vaultId);
    } catch (error) {
      console.error('Failed to get sync state:', error);
    }

    // Build confirmation message
    let confirmMessage = 'Are you sure you want to reset the initial sync state?\n\n';
    
    if (syncState && syncState.completed) {
      const optionLabels: Record<string, string> = {
        'start-fresh': 'Start Fresh',
        'upload-local': 'Upload Local',
        'smart-merge': 'Smart Merge'
      };
      const optionLabel = optionLabels[syncState.chosenOption] || syncState.chosenOption;
      
      confirmMessage += `Current state:\n`;
      confirmMessage += `- Option: ${optionLabel}\n`;
      confirmMessage += `- Completed: ${new Date(syncState.completedAt).toLocaleString()}\n`;
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

    if (!confirmed) {
      return;
    }

    try {
      // Reset the sync state
      await initialSyncService.resetSyncState(vaultId);
      
      // Show success notice
      new Notice('Initial sync state reset successfully. The wizard will appear on next connection.');
      
      // Refresh the settings display to update the description
      this.display();
    } catch (error) {
      console.error('Failed to reset initial sync state:', error);
      new Notice('Failed to reset initial sync state. Check console for details.');
    }
  }

  // Validation helpers
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
          text.inputEl.style.borderColor = 'var(--text-error)';
          return;
        }
        
        const success = await onChange(num);
        if (success) {
          text.inputEl.style.borderColor = '';
        } else {
          text.inputEl.style.borderColor = 'var(--text-error)';
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
      .setPlaceholder('http://localhost:3001')
      .setValue(initialValue)
      .onChange(async (value) => {
        const trimmed = value.trim();
        
        // Basic URL validation
        if (trimmed && !this.isValidUrl(trimmed)) {
          text.inputEl.style.borderColor = 'var(--text-error)';
          new Notice('Invalid URL format');
          return;
        }
        
        const success = await onChange(trimmed);
        if (success) {
          text.inputEl.style.borderColor = '';
        } else {
          text.inputEl.style.borderColor = 'var(--text-error)';
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

  // Settings import/export
  private async exportSettings(): Promise<void> {
    try {
      // Use SettingsManager if available, otherwise fallback to manual export
      let json: string;
      
      if ((this.plugin as any).settingsManager) {
        json = (this.plugin as any).settingsManager.exportSettings();
      } else {
        // Fallback: Create a sanitized copy of settings
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

  private async importSettings(): Promise<void> {
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json';
      
      input.onchange = async (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        
        const text = await file.text();
        
        // Use SettingsManager if available
        if ((this.plugin as any).settingsManager) {
          const success = await (this.plugin as any).settingsManager.importSettings(text);
          if (success) {
            this.display(); // Refresh UI
            new Notice('Settings imported successfully');
          } else {
            new Notice('Invalid settings file');
          }
        } else {
          // Fallback: Manual import
          const importedSettings = JSON.parse(text);
          
          if (!this.validateImportedSettings(importedSettings)) {
            new Notice('Invalid settings file');
            return;
          }
          
          Object.assign(this.plugin.settings, importedSettings);
          await this.plugin.saveSettings();
          this.display(); // Refresh UI
          new Notice('Settings imported successfully');
        }
      };
      
      input.click();
    } catch (error) {
      console.error('Failed to import settings:', error);
      new Notice('Failed to import settings');
    }
  }

  private validateImportedSettings(settings: any): boolean {
    if (typeof settings !== 'object' || settings === null) {
      return false;
    }
    
    if (settings.syncMode && !Object.values(SyncMode).includes(settings.syncMode)) {
      return false;
    }
    
    if (settings.includedFolders && !Array.isArray(settings.includedFolders)) {
      return false;
    }
    if (settings.excludedFolders && !Array.isArray(settings.excludedFolders)) {
      return false;
    }
    
    if (settings.syncInterval !== undefined && (typeof settings.syncInterval !== 'number' || settings.syncInterval <= 0)) {
      return false;
    }
    if (settings.maxConcurrentUploads !== undefined && (typeof settings.maxConcurrentUploads !== 'number' || settings.maxConcurrentUploads < 1)) {
      return false;
    }
    
    return true;
  }

  private async resetSettings(): Promise<void> {
    const confirmed = await showConfirmationModal(
      this.app,
      'Are you sure you want to reset all settings to defaults? This will preserve your authentication and device ID.',
      { title: 'Reset settings', confirmText: 'Reset', confirmClass: 'mod-warning' }
    );

    if (!confirmed) return;
    
    try {
      // Use SettingsManager if available
      if ((this.plugin as any).settingsManager) {
        await (this.plugin as any).settingsManager.resetSettings();
      } else {
        // Fallback: Manual reset
        const { DEFAULT_SETTINGS } = await import('../utils/constants');
        
        const apiKey = this.plugin.settings.apiKey;
        const apiKeyExpires = this.plugin.settings.apiKeyExpires;
        const selectedVaultId = this.plugin.settings.selectedVaultId;
        const deviceId = this.plugin.settings.deviceId;
        
        Object.assign(this.plugin.settings, DEFAULT_SETTINGS);
        
        this.plugin.settings.apiKey = apiKey;
        this.plugin.settings.apiKeyExpires = apiKeyExpires;
        this.plugin.settings.selectedVaultId = selectedVaultId;
        this.plugin.settings.deviceId = deviceId;
        
        await this.plugin.saveSettings();
      }
      
      this.display(); // Refresh UI
      new Notice('Settings reset to defaults');
    } catch (error) {
      console.error('Failed to reset settings:', error);
      new Notice('Failed to reset settings');
    }
  }
}
