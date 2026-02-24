import { App, Modal, Setting, Notice } from 'obsidian';
import { ConflictService } from '../services/ConflictService';
import { ConflictInfo, ResolutionStrategy } from '../types';
import { formatRelativeTime } from '../utils/helpers';

// Type extension to access private properties of ConflictService
interface ConflictServiceExtended {
  isCrossTenant?: boolean;
  vaultPermission?: 'read' | 'write' | 'admin';
}

/**
 * Conflict Resolution Modal
 * Displays conflicts and allows users to resolve them
 */
export class ConflictResolutionModal extends Modal {
  private conflictService: ConflictService;
  private conflicts: ConflictInfo[] = [];
  private currentConflictIndex: number = 0;
  private onResolved?: () => void;

  constructor(
    app: App,
    conflictService: ConflictService,
    onResolved?: () => void
  ) {
    super(app);
    this.conflictService = conflictService;
    this.onResolved = onResolved;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vaultsync-conflict-modal');

    // Load conflicts
    this.conflicts = this.conflictService.getConflicts();

    if (this.conflicts.length === 0) {
      this.showNoConflicts();
      return;
    }

    this.renderConflictView();
  }

  private showNoConflicts() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'No conflicts' });

    const message = contentEl.createDiv('vaultconnect-empty');
    message.textContent = 'All files are in sync. No conflicts to resolve.';

    const buttonContainer = contentEl.createDiv('vaultconnect-modal-footer');
    buttonContainer.setCssProps({ 'text-align': 'center' });

    const closeButton = buttonContainer.createEl('button', {
      text: 'Close',
      cls: 'mod-cta'
    });
    closeButton.addEventListener('click', () => {
      this.close();
    });
  }

  private renderConflictView() {
    const { contentEl } = this;
    contentEl.empty();

    const conflict = this.conflicts[this.currentConflictIndex];

    // Header
    const header = contentEl.createDiv();
    header.addClass('vaultconnect-header');

    const title = header.createEl('h2', {
      text: `Resolve conflict: ${conflict.path}`
    });
    title.addClass('vaultconnect-mb-sm');

    const info = header.createDiv();
    info.addClass('vaultconnect-text-muted');
    info.addClass('vaultconnect-text-sm');
    info.textContent = `Conflict ${this.currentConflictIndex + 1} of ${this.conflicts.length} • Type: ${conflict.conflictType}`;

    // Cross-tenant warning banner
    const serviceExt = this.conflictService as unknown as ConflictServiceExtended;
    const isCrossTenant = serviceExt.isCrossTenant;
    const permission = serviceExt.vaultPermission;

    if (isCrossTenant) {
      const warningBanner = contentEl.createDiv();
      warningBanner.addClass('vaultconnect-bg-warning');
      warningBanner.addClass('vaultconnect-p-md');
      warningBanner.addClass('vaultconnect-rounded-md');
      warningBanner.addClass('vaultconnect-mt-md');
      warningBanner.addClass('vaultconnect-mb-md');
      warningBanner.setCssProps({
        'background': 'rgba(255, 152, 0, 0.1)',
        'border': '1px solid rgba(255, 152, 0, 0.3)'
      });

      const warningTitle = warningBanner.createEl('div', {
        text: '🔗 cross-tenant vault conflict'
      });
      warningTitle.addClass('vaultconnect-font-semibold');
      warningTitle.addClass('vaultconnect-mb-sm');

      const warningText = warningBanner.createEl('div');
      warningText.addClass('vaultconnect-text-sm');
      warningText.setCssProps({ 'line-height': '1.4' });

      if (permission === 'read') {
        warningText.textContent = '⚠️ this vault is shared with read-only access. The remote version will be used automatically to prevent sync conflicts.';
      } else {
        warningText.textContent = '💡 for cross-tenant vaults, it\'s recommended to keep the remote version as the source of truth to avoid sync conflicts with the vault owner.';
      }
    }

    // Navigation buttons (if multiple conflicts)
    if (this.conflicts.length > 1) {
      const nav = header.createDiv();
      nav.addClass('vaultconnect-flex');
      nav.addClass('vaultconnect-gap-md');
      nav.addClass('vaultconnect-mt-md');

      const prevButton = nav.createEl('button', { text: '← previous conflict' });
      prevButton.disabled = this.currentConflictIndex === 0;
      prevButton.addEventListener('click', () => {
        this.currentConflictIndex--;
        this.renderConflictView();
      });

      const nextButton = nav.createEl('button', { text: 'Next conflict →' });
      nextButton.disabled = this.currentConflictIndex === this.conflicts.length - 1;
      nextButton.addEventListener('click', () => {
        this.currentConflictIndex++;
        this.renderConflictView();
      });
    }

    // Conflict details
    this.renderConflictDetails(contentEl, conflict);

    // Resolution buttons
    this.renderResolutionButtons(contentEl, conflict);
  }

  private renderConflictDetails(container: HTMLElement, conflict: ConflictInfo) {
    const detailsContainer = container.createDiv('conflict-details');
    detailsContainer.addClass('vaultconnect-mt-lg');

    // Timestamps
    const timestamps = detailsContainer.createDiv('conflict-timestamps');
    timestamps.addClass('vaultconnect-mb-md');
    timestamps.addClass('vaultconnect-flex');
    timestamps.addClass('vaultconnect-justify-between');
    timestamps.addClass('vaultconnect-text-sm');
    timestamps.addClass('vaultconnect-text-muted');

    const localTime = timestamps.createDiv();
    localTime.textContent = `Local: ${formatRelativeTime(conflict.localModified)}`;

    const remoteTime = timestamps.createDiv();
    remoteTime.textContent = `Remote: ${formatRelativeTime(conflict.remoteModified)}`;

    // Side-by-side diff view
    const diffContainer = detailsContainer.createDiv('conflict-diff');
    diffContainer.addClass('vaultconnect-grid');
    diffContainer.addClass('vaultconnect-grid-cols-2');
    diffContainer.addClass('vaultconnect-gap-md');
    diffContainer.addClass('vaultconnect-mb-lg');

    // Local version
    const localPanel = diffContainer.createDiv('conflict-panel');
    localPanel.addClass('vaultconnect-panel');
    localPanel.addClass('vaultconnect-p-md');

    const localHeader = localPanel.createDiv('conflict-panel-header');
    localHeader.textContent = 'Local version';
    localHeader.addClass('vaultconnect-font-semibold');
    localHeader.addClass('vaultconnect-mb-md');
    localHeader.addClass('vaultconnect-text-accent');

    const localContentEl = localPanel.createEl('pre', { cls: 'conflict-content' });
    localContentEl.addClass('vaultconnect-code-block');
    localContentEl.addClass('vaultconnect-max-h-300');
    localContentEl.addClass('vaultconnect-overflow-auto');
    localContentEl.addClass('vaultconnect-text-sm');

    // Remote version
    const remotePanel = diffContainer.createDiv('conflict-panel');
    remotePanel.addClass('vaultconnect-panel');
    remotePanel.addClass('vaultconnect-p-md');

    const remoteHeader = remotePanel.createDiv('conflict-panel-header');
    remoteHeader.textContent = 'Remote version';
    remoteHeader.addClass('vaultconnect-font-semibold');
    remoteHeader.addClass('vaultconnect-mb-md');
    remoteHeader.addClass('vaultconnect-text-accent');

    const remoteContentEl = remotePanel.createEl('pre', { cls: 'conflict-content' });
    remoteContentEl.addClass('vaultconnect-code-block');
    remoteContentEl.addClass('vaultconnect-max-h-300');
    remoteContentEl.addClass('vaultconnect-overflow-auto');
    remoteContentEl.addClass('vaultconnect-text-sm');

    // If content is already in memory, show it immediately; otherwise fetch on-demand
    if (conflict.localContent !== undefined && conflict.remoteContent !== undefined) {
      localContentEl.textContent = conflict.localContent || '(deleted)';
      remoteContentEl.textContent = conflict.remoteContent || '(deleted)';
    } else {
      localContentEl.textContent = 'Loading...';
      remoteContentEl.textContent = 'Loading...';

      this.conflictService.getConflictContent(conflict.id).then(({ localContent, remoteContent }) => {
        localContentEl.textContent = localContent || '(deleted)';
        remoteContentEl.textContent = remoteContent || '(deleted)';
      }).catch((err: Error) => {
        localContentEl.textContent = '(failed to load content)';
        remoteContentEl.textContent = '(failed to load content)';
        console.error('Failed to load conflict content:', err);
      });
    }
  }

  private renderResolutionButtons(container: HTMLElement, conflict: ConflictInfo) {
    const buttonContainer = container.createDiv('conflict-resolution-buttons');
    buttonContainer.addClass('vaultconnect-mt-lg');
    buttonContainer.addClass('vaultconnect-flex');
    buttonContainer.addClass('vaultconnect-flex-col');
    buttonContainer.addClass('vaultconnect-gap-md');

    // Check cross-tenant status
    const serviceExt = this.conflictService as unknown as ConflictServiceExtended;
    const isCrossTenant = serviceExt.isCrossTenant;
    const permission = serviceExt.vaultPermission;
    const isReadOnly = isCrossTenant && permission === 'read';

    // Resolution options
    const optionsContainer = buttonContainer.createDiv('resolution-options');
    optionsContainer.addClass('vaultconnect-grid');
    optionsContainer.addClass('vaultconnect-grid-cols-2');
    optionsContainer.addClass('vaultconnect-gap-md');

    // Keep Local button (disabled for read-only cross-tenant vaults)
    const keepLocalBtn = optionsContainer.createEl('button', {
      text: 'Keep local',
      cls: 'mod-cta'
    });

    if (isReadOnly) {
      keepLocalBtn.disabled = true;
      keepLocalBtn.title = 'Cannot keep local version in read-only cross-tenant vault';
      keepLocalBtn.addClass('vaultconnect-btn-disabled');
    } else {
      keepLocalBtn.addEventListener('click', () => {
        void this.resolveConflict(conflict, ResolutionStrategy.KEEP_LOCAL);
      });
    }

    // Keep Remote button
    const keepRemoteBtn = optionsContainer.createEl('button', {
      text: 'Keep remote',
      cls: 'mod-cta'
    });
    keepRemoteBtn.addEventListener('click', () => {
      void this.resolveConflict(conflict, ResolutionStrategy.KEEP_REMOTE);
    });

    // Keep Both button
    const keepBothBtn = optionsContainer.createEl('button', {
      text: 'Keep both'
    });
    keepBothBtn.addEventListener('click', () => {
      void this.resolveConflict(conflict, ResolutionStrategy.KEEP_BOTH);
    });

    // Merge Manually button
    const mergeBtn = optionsContainer.createEl('button', {
      text: 'Merge manually'
    });
    mergeBtn.addEventListener('click', () => {
      this.showMergeEditor(conflict);
    });

    // Cancel button
    const actionContainer = buttonContainer.createDiv('action-buttons');
    actionContainer.addClass('vaultconnect-flex');
    actionContainer.addClass('vaultconnect-justify-between');
    actionContainer.addClass('vaultconnect-mt-md');

    const skipBtn = actionContainer.createEl('button', { text: 'Skip' });
    skipBtn.addEventListener('click', () => {
      if (this.currentConflictIndex < this.conflicts.length - 1) {
        this.currentConflictIndex++;
        this.renderConflictView();
      } else {
        this.close();
      }
    });

    const closeBtn = actionContainer.createEl('button', { text: 'Close' });
    closeBtn.addEventListener('click', () => {
      this.close();
    });
  }

  private showMergeEditor(conflict: ConflictInfo) {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: `Manual merge: ${conflict.path}` });

    const description = contentEl.createDiv('merge-description');
    description.textContent = 'Edit the content below to create your merged version:';
    description.addClass('vaultconnect-mb-md');
    description.addClass('vaultconnect-text-muted');

    // Show loading state while fetching content
    const loadingEl = contentEl.createDiv('merge-loading');
    loadingEl.textContent = 'Loading file content...';
    loadingEl.addClass('vaultconnect-text-muted');

    // Fetch content then render editor
    const buildEditor = (localContent: string, remoteContent: string) => {
      loadingEl.remove();

      let mergedContent = this.createMergeTemplate(localContent, remoteContent);

      // Preview section
      const previewContainer = contentEl.createDiv('merge-preview');
      previewContainer.addClass('vaultconnect-mt-lg');

      const previewHeader = previewContainer.createEl('h3', { text: 'Preview' });
      previewHeader.addClass('vaultconnect-mb-md');

      const previewContent = previewContainer.createEl('div', { cls: 'merge-preview-content' });
      previewContent.addClass('vaultconnect-panel');
      previewContent.addClass('vaultconnect-p-md');
      previewContent.addClass('vaultconnect-max-h-200');
      previewContent.addClass('vaultconnect-overflow-auto');
      previewContent.addClass('vaultconnect-code-block');
      previewContent.textContent = mergedContent;

      new Setting(contentEl)
        .setName('Merged content')
        .setDesc('Combine both versions as needed')
        .addTextArea(text => {
          text
            .setValue(mergedContent)
            .onChange(value => {
              mergedContent = value;
              previewContent.textContent = value;
            });
          text.inputEl.rows = 20;
          text.inputEl.addClass('vaultconnect-w-full');
          text.inputEl.addClass('vaultconnect-font-mono');
          text.inputEl.addClass('vaultconnect-text-sm');
        });

      // Buttons
      const buttonContainer = contentEl.createDiv('modal-button-container');
      buttonContainer.addClass('vaultconnect-mt-lg');
      buttonContainer.addClass('vaultconnect-flex');
      buttonContainer.addClass('vaultconnect-justify-end');
      buttonContainer.addClass('vaultconnect-gap-md');

      const backButton = buttonContainer.createEl('button', { text: 'Back' });
      backButton.addEventListener('click', () => {
        this.renderConflictView();
      });

      const saveButton = buttonContainer.createEl('button', {
        text: 'Save merged version',
        cls: 'mod-cta'
      });
      saveButton.addEventListener('click', () => {
        void this.resolveConflict(conflict, ResolutionStrategy.MERGE_MANUAL, mergedContent);
      });
    };

    // If content is in memory, use it directly; otherwise fetch on-demand
    if (conflict.localContent !== undefined && conflict.remoteContent !== undefined) {
      buildEditor(conflict.localContent, conflict.remoteContent);
    } else {
      this.conflictService.getConflictContent(conflict.id).then(({ localContent, remoteContent }) => {
        buildEditor(localContent, remoteContent);
      }).catch((err: Error) => {
        loadingEl.textContent = 'Failed to load file content. Please close and try again.';
        console.error('Failed to load conflict content for merge:', err);
      });
    }
  }

  private createMergeTemplate(localContent: string, remoteContent: string): string {
    // Create a merge template with conflict markers
    return `<<<<<<< LOCAL\n${localContent}\n=======\n${remoteContent}\n>>>>>>> REMOTE`;
  }

  private async resolveConflict(
    conflict: ConflictInfo,
    strategy: ResolutionStrategy,
    mergedContent?: string
  ) {
    try {
      // Show resolving notice
      new Notice(`Resolving conflict...`);

      // Call the conflict service to resolve
      await this.conflictService.resolveConflict(conflict.id, {
        strategy,
        mergedContent
      });

      // Show success notice
      new Notice(`Conflict resolved: ${conflict.path}`);
      
      // Remove conflict from list
      this.conflicts = this.conflicts.filter(c => c.id !== conflict.id);
      
      // If no more conflicts, close modal
      if (this.conflicts.length === 0) {
        new Notice('All conflicts resolved!');
        if (this.onResolved) {
          this.onResolved();
        }
        this.close();
        return;
      }

      // Move to next conflict or previous if at end
      if (this.currentConflictIndex >= this.conflicts.length) {
        this.currentConflictIndex = this.conflicts.length - 1;
      }

      // Re-render
      this.renderConflictView();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to resolve conflict: ${errorMessage}`);
      console.error('Error resolving conflict:', error);
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
