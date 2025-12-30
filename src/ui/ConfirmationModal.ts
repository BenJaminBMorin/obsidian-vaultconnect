import { App, Modal, Setting } from 'obsidian';

/**
 * Options for the confirmation modal
 */
export interface ConfirmationModalOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmClass?: 'mod-cta' | 'mod-warning' | 'mod-destructive';
}

/**
 * Confirmation Modal
 * Replaces native confirm() dialogs with an Obsidian-styled modal
 */
export class ConfirmationModal extends Modal {
  private options: ConfirmationModalOptions;
  private resolved: boolean = false;
  private resolvePromise: ((value: boolean) => void) | null = null;

  constructor(app: App, options: ConfirmationModalOptions) {
    super(app);
    this.options = {
      title: options.title || 'Confirm',
      message: options.message,
      confirmText: options.confirmText || 'Confirm',
      cancelText: options.cancelText || 'Cancel',
      confirmClass: options.confirmClass || 'mod-cta'
    };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Add title
    if (this.options.title) {
      contentEl.createEl('h3', { text: this.options.title });
    }

    // Add message
    contentEl.createEl('p', { text: this.options.message });

    // Add buttons
    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText(this.options.cancelText!)
        .onClick(() => {
          this.resolved = true;
          this.resolvePromise?.(false);
          this.close();
        }))
      .addButton(btn => {
        btn.setButtonText(this.options.confirmText!);
        if (this.options.confirmClass === 'mod-warning') {
          btn.setWarning();
        } else if (this.options.confirmClass === 'mod-cta') {
          btn.setCta();
        }
        btn.onClick(() => {
          this.resolved = true;
          this.resolvePromise?.(true);
          this.close();
        });
      });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();

    // If closed without explicit choice, treat as cancel
    if (!this.resolved) {
      this.resolvePromise?.(false);
    }
  }

  /**
   * Show the modal and wait for user response
   */
  async waitForConfirmation(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}

/**
 * Helper function to show a confirmation modal
 * Replaces native confirm() calls
 */
export async function showConfirmationModal(
  app: App,
  message: string,
  options?: Partial<ConfirmationModalOptions>
): Promise<boolean> {
  const modal = new ConfirmationModal(app, {
    message,
    ...options
  });
  return modal.waitForConfirmation();
}
