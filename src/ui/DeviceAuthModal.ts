import { App, Modal, Notice, Setting } from 'obsidian';
import { AuthService } from '../services/AuthService';
import { logger } from '../utils/logger';

/**
 * Device Authorization Modal
 * Shows the user code and opens browser for authorization
 */
export class DeviceAuthModal extends Modal {
  private authService: AuthService;
  private apiBaseUrl: string;
  private onSuccess: () => void;
  private onCancel: () => void;
  private userCode: string = '';
  private verificationUri: string = '';
  private isAuthorizing: boolean = false;
  private statusEl: HTMLElement | null = null;

  constructor(
    app: App,
    authService: AuthService,
    apiBaseUrl: string,
    onSuccess: () => void,
    onCancel: () => void
  ) {
    super(app);
    this.authService = authService;
    this.apiBaseUrl = apiBaseUrl;
    this.onSuccess = onSuccess;
    this.onCancel = onCancel;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vaultsync-device-auth-modal');

    contentEl.createEl('h2', { text: 'Authorize Vault Connect' });

    contentEl.createEl('p', {
      text: 'To connect your Obsidian vault, authorize this device from your browser.',
      cls: 'setting-item-description'
    });

    // Status container
    this.statusEl = contentEl.createDiv({ cls: 'device-auth-status' });
    const loadingDiv = this.statusEl.createDiv({ cls: 'device-auth-loading' });
    loadingDiv.createDiv({ cls: 'spinner' });
    loadingDiv.createEl('p', { text: 'Requesting authorization code...' });

    // Start the authorization flow
    void this.startAuthFlow();
  }

  private async startAuthFlow() {
    try {
      this.isAuthorizing = true;

      await this.authService.startDeviceAuthFlow(
        this.apiBaseUrl,
        (userCode, verificationUri) => {
          // Called when device code is received
          this.userCode = userCode;
          this.verificationUri = verificationUri;
          this.showUserCode();

          // Automatically open browser
          window.open(verificationUri, '_blank');
        }
      );

      // Success! Token received
      new Notice('Successfully authorized!');
      this.close();
      this.onSuccess();
    } catch (error) {
      logger.error('Authorization failed:', error);
      this.showError(error.message || 'Authorization failed');
    } finally {
      this.isAuthorizing = false;
    }
  }

  private showUserCode() {
    if (!this.statusEl) return;

    this.statusEl.empty();

    // Success message
    const successDiv = this.statusEl.createDiv({ cls: 'device-auth-success' });
    successDiv.createEl('div', { cls: 'success-icon', text: '✓' });
    successDiv.createEl('p', { text: 'Code generated successfully!' });

    // User code display
    const codeContainer = this.statusEl.createDiv({ cls: 'user-code-container' });
    codeContainer.createEl('p', {
      text: 'Enter this code in your browser:',
      cls: 'user-code-label'
    });

    const codeDisplay = codeContainer.createDiv({ cls: 'user-code-display' });
    codeDisplay.createEl('span', {
      text: this.userCode,
      cls: 'user-code'
    });

    // Copy button
    const copyButton = codeDisplay.createEl('button', {
      text: '📋 Copy code',
      cls: 'user-code-copy-btn'
    });
    copyButton.addEventListener('click', () => {
      void navigator.clipboard.writeText(this.userCode);
      new Notice('Code copied to clipboard!');
      copyButton.textContent = '✓ Copied';
      setTimeout(() => {
        copyButton.textContent = '📋 Copy code';
      }, 2000);
    });

    // Instructions
    const instructionsDiv = this.statusEl.createDiv({ cls: 'device-auth-instructions' });
    instructionsDiv.createEl('p', {
      text: '1. A browser window should have opened automatically',
      cls: 'instruction-step'
    });
    instructionsDiv.createEl('p', {
      text: '2. If not, click the button below to open it manually',
      cls: 'instruction-step'
    });
    instructionsDiv.createEl('p', {
      text: '3. Enter the code above and choose your token expiration',
      cls: 'instruction-step'
    });
    instructionsDiv.createEl('p', {
      text: '4. Click "Authorize" to complete the process',
      cls: 'instruction-step'
    });

    // Open browser button
    const buttonContainer = this.statusEl.createDiv({ cls: 'device-auth-buttons' });
    const openBrowserBtn = buttonContainer.createEl('button', {
      text: 'Open browser',
      cls: 'mod-cta'
    });
    openBrowserBtn.addEventListener('click', () => {
      window.open(this.verificationUri, '_blank');
    });

    // Cancel button
    const cancelBtn = buttonContainer.createEl('button', {
      text: 'Cancel',
    });
    cancelBtn.addEventListener('click', () => {
      this.close();
      this.onCancel();
    });

    // Waiting message
    const waitingDiv = this.statusEl.createDiv({ cls: 'device-auth-waiting' });
    waitingDiv.createDiv({ cls: 'spinner' });
    waitingDiv.createEl('p', { text: 'Waiting for authorization...' });
    waitingDiv.createEl('p', { text: 'This window will close automatically once you authorize', cls: 'waiting-subtitle' });
  }

  private showError(message: string) {
    if (!this.statusEl) return;

    this.statusEl.empty();

    const errorDiv = this.statusEl.createDiv({ cls: 'device-auth-error' });
    errorDiv.createEl('div', { cls: 'error-icon', text: '✗' });
    errorDiv.createEl('h3', { text: 'Authorization failed' });
    errorDiv.createEl('p', { text: message });

    // Retry button
    const buttonContainer = errorDiv.createDiv({ cls: 'device-auth-buttons' });
    const retryBtn = buttonContainer.createEl('button', {
      text: 'Try again',
      cls: 'mod-cta'
    });
    retryBtn.addEventListener('click', () => {
      void this.onOpen();
    });

    const closeBtn = buttonContainer.createEl('button', {
      text: 'Close',
    });
    closeBtn.addEventListener('click', () => {
      this.close();
      this.onCancel();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
