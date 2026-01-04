import { App, Modal, Setting, Notice } from 'obsidian';
import { AuthService } from '../services/AuthService';

/**
 * Authentication Modal
 * Allows users to input their API key
 */
export class AuthModal extends Modal {
  private authService: AuthService;
  private onSuccess: () => void;
  private apiKeyInput: string = '';

  constructor(app: App, authService: AuthService, onSuccess: () => void) {
    super(app);
    this.authService = authService;
    this.onSuccess = onSuccess;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'VaultSync Authentication' });

    contentEl.createEl('p', {
      text: 'Enter your VaultSync API key to connect your vault. You can generate an API key from your VaultSync dashboard.',
      cls: 'setting-item-description'
    });

    // API Key input
    new Setting(contentEl)
      .setName('API Key')
      .setDesc('Your VaultSync API key (starts with vb_live_ or vb_test_)')
      .addText(text => {
        text
          .setPlaceholder('vb_live_...')
          .setValue(this.apiKeyInput)
          .onChange(value => {
            this.apiKeyInput = value.trim();
          });
        text.inputEl.type = 'password';
        text.inputEl.addClass('vaultconnect-w-full');

        // Focus on input
        setTimeout(() => text.inputEl.focus(), 100);
      });

    // Expiration info
    contentEl.createEl('p', {
      text: 'API keys expire after 90 days. You will be notified when your key is about to expire.',
      cls: 'setting-item-description'
    });

    // Buttons
    const buttonContainer = contentEl.createDiv('modal-button-container');
    buttonContainer.addClass('vaultconnect-flex');
    buttonContainer.addClass('vaultconnect-justify-end');
    buttonContainer.addClass('vaultconnect-gap-md');
    buttonContainer.addClass('vaultconnect-mt-lg');

    // Cancel button
    const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.close();
    });

    // Login button
    const loginButton = buttonContainer.createEl('button', {
      text: 'Connect',
      cls: 'mod-cta'
    });
    loginButton.addEventListener('click', () => {
      this.handleLogin();
    });

    // Handle Enter key
    contentEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleLogin();
      }
    });

    // Help link
    const helpContainer = contentEl.createDiv('setting-item-description');
    helpContainer.addClass('vaultconnect-mt-lg');
    helpContainer.addClass('vaultconnect-text-center');
    
    const helpLink = helpContainer.createEl('a', {
      text: 'How to get an API key?',
      href: '#'
    });
    helpLink.addEventListener('click', (e) => {
      e.preventDefault();
      this.showHelp();
    });
  }

  private async handleLogin() {
    if (!this.apiKeyInput) {
      new Notice('Please enter an API key');
      return;
    }

    // Validate format
    if (!this.authService.validateApiKeyFormat(this.apiKeyInput)) {
      new Notice('Invalid API key format. Key should start with vb_live_ or vb_test_');
      return;
    }

    try {
      // Calculate expiration (90 days from now)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90);

      // Store the API key
      await this.authService.storeApiKey(this.apiKeyInput, expiresAt);

      new Notice('Successfully authenticated with VaultSync!');
      this.close();
      this.onSuccess();
    } catch (error) {
      console.error('Authentication failed:', error);
      new Notice(`Authentication failed: ${error.message}`);
    }
  }

  private showHelp() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'How to get an API key' });

    const steps = [
      'Log in to your VaultSync dashboard at https://vaultsync.io',
      'Navigate to Settings → API Keys',
      'Click "Generate New API Key"',
      'Give your key a name (e.g., "Obsidian Desktop")',
      'Select the scopes: vault:read, vault:write, file:read, file:write',
      'Click "Generate" and copy the API key',
      'Paste the key here in Obsidian'
    ];

    const ol = contentEl.createEl('ol');
    steps.forEach(step => {
      ol.createEl('li', { text: step });
    });

    contentEl.createEl('p', {
      text: 'Important: The API key will only be shown once. Make sure to copy it before closing the dialog.',
      cls: 'mod-warning'
    });

    // Back button
    const buttonContainer = contentEl.createDiv('modal-button-container');
    buttonContainer.addClass('vaultconnect-mt-lg');
    
    const backButton = buttonContainer.createEl('button', {
      text: 'Back',
      cls: 'mod-cta'
    });
    backButton.addEventListener('click', () => {
      this.onOpen();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
