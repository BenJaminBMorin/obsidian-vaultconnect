import { Plugin, TFile, setIcon } from 'obsidian';
import { EventBus, EVENTS } from '../core/EventBus';
import { StorageManager } from '../core/StorageManager';
import { PresenceService } from './PresenceService';
import { FileInfo } from '../types';

export interface FileMetadata {
  filePath: string;
  lastEditor: {
    userId: string;
    userName: string;
    userAvatar?: string;
  };
  lastModified: Date;
  modifiedByOthers: boolean;
}

export interface ActivityEntry {
  userId: string;
  userName: string;
  filePath: string;
  action: 'opened' | 'closed' | 'modified';
  timestamp: Date;
}

/**
 * Collaboration Metadata Service
 * Tracks and displays file editing metadata
 */
export class CollaborationMetadataService {
  private plugin: Plugin;
  private eventBus: EventBus;
  private storage: StorageManager;
  private presenceService: PresenceService;
  
  // File metadata cache
  private fileMetadata: Map<string, FileMetadata> = new Map();
  
  // Recent activity log
  private recentActivity: ActivityEntry[] = [];
  private maxActivityEntries: number = 100;
  
  // Current user ID
  private currentUserId: string | null = null;
  
  // File list decorations
  private fileDecorations: Map<string, HTMLElement> = new Map();
  
  private unsubscribers: (() => void)[] = [];
  private debugMode: boolean = false;

  constructor(
    plugin: Plugin,
    eventBus: EventBus,
    storage: StorageManager,
    presenceService: PresenceService,
    debugMode: boolean = false
  ) {
    this.plugin = plugin;
    this.eventBus = eventBus;
    this.storage = storage;
    this.presenceService = presenceService;
    this.debugMode = debugMode;
  }

  /**
   * Initialize metadata service
   */
  async initialize(currentUserId: string): Promise<void> {
    this.currentUserId = currentUserId;
    this.log('Initializing collaboration metadata service');
    
    // Load cached metadata
    await this.loadMetadataCache();
    
    // Setup event listeners
    this.setupEventListeners();
    
    // Setup file explorer decorations
    this.setupFileExplorerDecorations();
    
    this.log('Collaboration metadata service initialized');
  }

  /**
   * Store file metadata
   */
  async storeFileMetadata(filePath: string, editor: { userId: string; userName: string; userAvatar?: string }): Promise<void> {
    const metadata: FileMetadata = {
      filePath,
      lastEditor: editor,
      lastModified: new Date(),
      modifiedByOthers: editor.userId !== this.currentUserId
    };

    this.fileMetadata.set(filePath, metadata);
    await this.saveMetadataCache();
    
    // Add to recent activity
    this.addActivityEntry({
      userId: editor.userId,
      userName: editor.userName,
      filePath,
      action: 'modified',
      timestamp: new Date()
    });
    
    // Update file decoration
    this.updateFileDecoration(filePath);
    
    this.log(`Stored metadata for ${filePath}`, metadata);
  }

  /**
   * Get file metadata
   */
  getFileMetadata(filePath: string): FileMetadata | null {
    return this.fileMetadata.get(filePath) || null;
  }

  /**
   * Get files modified by others
   */
  getFilesModifiedByOthers(): FileMetadata[] {
    return Array.from(this.fileMetadata.values())
      .filter(metadata => metadata.modifiedByOthers);
  }

  /**
   * Get recent activity
   */
  getRecentActivity(hours: number = 24): ActivityEntry[] {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - hours);
    
    return this.recentActivity.filter(entry => entry.timestamp >= cutoff);
  }

  /**
   * Get activity for a specific file
   */
  getFileActivity(filePath: string, hours: number = 24): ActivityEntry[] {
    return this.getRecentActivity(hours).filter(entry => entry.filePath === filePath);
  }

  /**
   * Get activity for a specific user
   */
  getUserActivity(userId: string, hours: number = 24): ActivityEntry[] {
    return this.getRecentActivity(hours).filter(entry => entry.userId === userId);
  }

  /**
   * Check if file was modified by others
   */
  wasModifiedByOthers(filePath: string): boolean {
    const metadata = this.fileMetadata.get(filePath);
    return metadata?.modifiedByOthers || false;
  }

  /**
   * Clear modification flag for file
   */
  clearModificationFlag(filePath: string): void {
    const metadata = this.fileMetadata.get(filePath);
    if (metadata) {
      metadata.modifiedByOthers = false;
      this.updateFileDecoration(filePath);
    }
  }

  /**
   * Get tooltip text for file
   */
  getFileTooltip(filePath: string): string | null {
    const metadata = this.fileMetadata.get(filePath);
    if (!metadata) {
      return null;
    }

    const timeAgo = this.formatTimeAgo(metadata.lastModified);
    return `Last edited by ${metadata.lastEditor.userName} ${timeAgo}`;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.unsubscribers.forEach(unsub => unsub());
    this.unsubscribers = [];
    this.fileDecorations.clear();
  }

  // Private methods

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen for file opened events
    this.unsubscribers.push(
      this.presenceService.onFileOpened((userId: string, filePath: string) => {
        const activeUsers = this.presenceService.getActiveUsers();
        const user = activeUsers.find(u => u.userId === userId);
        
        if (user) {
          this.addActivityEntry({
            userId,
            userName: user.userName,
            filePath,
            action: 'opened',
            timestamp: new Date()
          });
        }
      })
    );

    // Listen for file closed events
    this.unsubscribers.push(
      this.presenceService.onFileClosed((userId: string, filePath: string) => {
        const activeUsers = this.presenceService.getActiveUsers();
        const user = activeUsers.find(u => u.userId === userId);
        
        if (user) {
          this.addActivityEntry({
            userId,
            userName: user.userName,
            filePath,
            action: 'closed',
            timestamp: new Date()
          });
        }
      })
    );

    // Listen for sync events to update metadata
    this.eventBus.on(EVENTS.FILE_SYNCED, (data: any) => {
      if (data.lastEditor) {
        this.storeFileMetadata(data.filePath, data.lastEditor);
      }
    });

    // Listen for file open in workspace to clear modification flag
    this.plugin.app.workspace.on('file-open', (file: TFile | null) => {
      if (file) {
        this.clearModificationFlag(file.path);
      }
    });
  }

  /**
   * Setup file explorer decorations
   */
  private setupFileExplorerDecorations(): void {
    // Register event to decorate files in file explorer
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('layout-change', () => {
        this.decorateFileExplorer();
      })
    );

    // Initial decoration
    this.decorateFileExplorer();
  }

  /**
   * Decorate file explorer with metadata indicators
   */
  private decorateFileExplorer(): void {
    // Get file explorer
    const fileExplorer = this.plugin.app.workspace.getLeavesOfType('file-explorer')[0];
    if (!fileExplorer) {
      return;
    }

    // Find all file items
    const fileItems = fileExplorer.view.containerEl.querySelectorAll('.tree-item-self');
    
    fileItems.forEach((item: Element) => {
      const titleEl = item.querySelector('.tree-item-inner');
      if (!titleEl) {
        return;
      }

      const fileName = titleEl.textContent;
      if (!fileName) {
        return;
      }

      // Find the file
      const file = this.plugin.app.vault.getAbstractFileByPath(fileName);
      if (!(file instanceof TFile)) {
        return;
      }

      // Check if file was modified by others
      if (this.wasModifiedByOthers(file.path)) {
        this.addFileIndicator(item as HTMLElement, file.path);
      }
    });
  }

  /**
   * Add indicator to file item
   */
  private addFileIndicator(itemEl: HTMLElement, filePath: string): void {
    // Check if indicator already exists
    if (itemEl.querySelector('.collab-indicator')) {
      return;
    }

    const indicator = itemEl.createDiv('collab-indicator');
    indicator.style.display = 'inline-block';
    indicator.style.marginLeft = '4px';
    indicator.style.fontSize = '12px';
    indicator.style.color = 'var(--interactive-accent)';
    indicator.textContent = '●';
    
    // Add tooltip
    const tooltip = this.getFileTooltip(filePath);
    if (tooltip) {
      indicator.setAttribute('aria-label', tooltip);
      indicator.setAttribute('title', tooltip);
    }

    this.fileDecorations.set(filePath, indicator);
  }

  /**
   * Update file decoration
   */
  private updateFileDecoration(filePath: string): void {
    const indicator = this.fileDecorations.get(filePath);
    if (!indicator) {
      // Trigger re-decoration
      this.decorateFileExplorer();
      return;
    }

    // Update tooltip
    const tooltip = this.getFileTooltip(filePath);
    if (tooltip) {
      indicator.setAttribute('aria-label', tooltip);
      indicator.setAttribute('title', tooltip);
    }

    // Update visibility based on modification flag
    if (!this.wasModifiedByOthers(filePath)) {
      indicator.remove();
      this.fileDecorations.delete(filePath);
    }
  }

  /**
   * Add activity entry
   */
  private addActivityEntry(entry: ActivityEntry): void {
    this.recentActivity.unshift(entry);
    
    // Trim to max entries
    if (this.recentActivity.length > this.maxActivityEntries) {
      this.recentActivity = this.recentActivity.slice(0, this.maxActivityEntries);
    }
    
    // Emit event
    this.eventBus.emit('collab:activity', entry);
  }

  /**
   * Load metadata cache
   */
  private async loadMetadataCache(): Promise<void> {
    const cached = await this.storage.get<Record<string, FileMetadata>>('fileMetadata');
    if (cached) {
      Object.entries(cached).forEach(([filePath, metadata]) => {
        // Convert date strings back to Date objects
        metadata.lastModified = new Date(metadata.lastModified);
        this.fileMetadata.set(filePath, metadata);
      });
    }

    const cachedActivity = await this.storage.get<ActivityEntry[]>('recentActivity');
    if (cachedActivity) {
      this.recentActivity = cachedActivity.map(entry => ({
        ...entry,
        timestamp: new Date(entry.timestamp)
      }));
    }
  }

  /**
   * Save metadata cache
   */
  private async saveMetadataCache(): Promise<void> {
    const metadataObj: Record<string, FileMetadata> = {};
    this.fileMetadata.forEach((metadata, filePath) => {
      metadataObj[filePath] = metadata;
    });
    
    await this.storage.set('fileMetadata', metadataObj);
    await this.storage.set('recentActivity', this.recentActivity);
  }

  /**
   * Format time ago
   */
  private formatTimeAgo(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) {
      return 'just now';
    } else if (minutes < 60) {
      return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    } else if (hours < 24) {
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else if (days < 7) {
      return `${days} day${days > 1 ? 's' : ''} ago`;
    } else {
      return date.toLocaleDateString();
    }
  }

  /**
   * Log message (if debug mode enabled)
   */
  private log(message: string, data?: any): void {
    if (this.debugMode) {
      if (data !== undefined) {
        console.debug(`[CollaborationMetadataService] ${message}`, data);
      } else {
        console.debug(`[CollaborationMetadataService] ${message}`);
      }
    }
  }
}
