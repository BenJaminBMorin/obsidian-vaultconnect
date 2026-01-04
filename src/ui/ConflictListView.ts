import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import { ConflictService } from '../services/ConflictService';
import { ConflictInfo } from '../types';
import { formatRelativeTime } from '../utils/helpers';
import { ConflictResolutionModal } from './ConflictResolutionModal';

export const CONFLICT_LIST_VIEW_TYPE = 'vaultsync-conflict-list';

/**
 * Conflict List View
 * Shows all conflicts in a sidebar panel
 */
export class ConflictListView extends ItemView {
  private conflictService: ConflictService;
  private conflicts: ConflictInfo[] = [];

  constructor(leaf: WorkspaceLeaf, conflictService: ConflictService) {
    super(leaf);
    this.conflictService = conflictService;
  }

  getViewType(): string {
    return CONFLICT_LIST_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Conflicts';
  }

  getIcon(): string {
    return 'alert-triangle';
  }

  async onOpen() {
    await this.refresh();
  }

  async refresh() {
    this.conflicts = this.conflictService.getConflicts();
    this.render();
  }

  private render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('vaultsync-conflict-list');

    // Header
    const header = container.createDiv('conflict-list-header');
    header.addClass('vaultconnect-header');
    header.addClass('vaultconnect-p-lg');
    header.addClass('vaultconnect-border-bottom');

    const title = header.createEl('h4', { text: 'Sync Conflicts' });
    title.addClass('vaultconnect-mb-sm');
    title.setCssProps({ 'margin-top': '0' });

    const count = header.createDiv('conflict-count');
    count.addClass('vaultconnect-text-sm');
    count.addClass('vaultconnect-text-muted');
    
    if (this.conflicts.length === 0) {
      count.textContent = 'No conflicts';
    } else {
      count.textContent = `${this.conflicts.length} conflict${this.conflicts.length === 1 ? '' : 's'} to resolve`;
    }

    // Refresh button
    const refreshBtn = header.createEl('button', {
      text: 'Refresh',
      cls: 'clickable-icon'
    });
    refreshBtn.addClass('vaultconnect-mt-sm');
    refreshBtn.addEventListener('click', () => {
      this.refresh();
    });

    // Content
    const content = container.createDiv('conflict-list-content');
    content.addClass('vaultconnect-p-sm');
    content.addClass('vaultconnect-overflow-auto');

    if (this.conflicts.length === 0) {
      this.renderEmptyState(content);
    } else {
      this.renderConflictList(content);
    }
  }

  private renderEmptyState(container: HTMLElement) {
    const empty = container.createDiv('conflict-list-empty');
    empty.addClass('vaultconnect-empty');
    empty.addClass('vaultconnect-text-center');

    const icon = empty.createDiv('conflict-empty-icon');
    icon.textContent = '✓';
    icon.addClass('vaultconnect-text-success');
    icon.addClass('vaultconnect-mb-lg');
    icon.setCssProps({ 'font-size': '48px' });

    const message = empty.createDiv('conflict-empty-message');
    message.textContent = 'All files are in sync';
    message.setCssProps({ 'font-size': '1.1em' });
  }

  private renderConflictList(container: HTMLElement) {
    this.conflicts.forEach(conflict => {
      this.renderConflictItem(container, conflict);
    });

    // Resolve all button
    const footer = container.createDiv('conflict-list-footer');
    footer.addClass('vaultconnect-mt-lg');
    footer.addClass('vaultconnect-p-sm');
    footer.addClass('vaultconnect-border-top');

    const resolveAllBtn = footer.createEl('button', {
      text: 'Resolve All Conflicts',
      cls: 'mod-cta'
    });
    resolveAllBtn.addClass('vaultconnect-w-full');
    resolveAllBtn.addEventListener('click', () => {
      this.openConflictResolutionModal();
    });
  }

  private renderConflictItem(container: HTMLElement, conflict: ConflictInfo) {
    const item = container.createDiv('conflict-list-item');
    item.addClass('vaultconnect-conflict-item');
    item.addClass('vaultconnect-p-md');
    item.addClass('vaultconnect-mb-sm');
    item.addClass('vaultconnect-rounded-md');
    item.addClass('vaultconnect-cursor-pointer');

    // Click to resolve
    item.addEventListener('click', () => {
      this.openConflictResolutionModal(conflict);
    });

    // Conflict type badge
    const badge = item.createDiv('conflict-type-badge');
    badge.textContent = conflict.conflictType.toUpperCase();
    badge.addClass('vaultconnect-badge');
    badge.addClass('vaultconnect-mb-sm');
    badge.setCssProps({ 'font-size': '0.75em' });

    if (conflict.conflictType === 'content') {
      badge.addClass('vaultconnect-badge--error');
    } else if (conflict.conflictType === 'deletion') {
      badge.addClass('vaultconnect-badge--warning');
    }

    // File path
    const path = item.createDiv('conflict-path');
    path.textContent = conflict.path;
    path.addClass('vaultconnect-font-medium');
    path.addClass('vaultconnect-mb-xs');
    path.addClass('vaultconnect-word-break');

    // Timestamps
    const timestamps = item.createDiv('conflict-timestamps');
    timestamps.addClass('vaultconnect-text-sm');
    timestamps.addClass('vaultconnect-text-muted');

    const localTime = formatRelativeTime(conflict.localModified);
    const remoteTime = formatRelativeTime(conflict.remoteModified);
    timestamps.textContent = `Local: ${localTime} • Remote: ${remoteTime}`;

    // Action hint
    const hint = item.createDiv('conflict-hint');
    hint.textContent = 'Click to resolve →';
    hint.addClass('vaultconnect-text-xs');
    hint.addClass('vaultconnect-text-accent');
    hint.addClass('vaultconnect-mt-sm');
  }

  private openConflictResolutionModal(conflict?: ConflictInfo) {
    const modal = new ConflictResolutionModal(
      this.app,
      this.conflictService,
      () => {
        // Refresh the list after resolution
        this.refresh();
      }
    );

    // If a specific conflict was clicked, navigate to it
    if (conflict) {
      const conflicts = this.conflictService.getConflicts();
      const index = conflicts.findIndex(c => c.id === conflict.id);
      if (index >= 0) {
        // Set the current index (we'll need to expose this in the modal)
        // For now, the modal will start at the first conflict
      }
    }

    modal.open();
  }

  async onClose() {
    // Cleanup if needed
  }
}
