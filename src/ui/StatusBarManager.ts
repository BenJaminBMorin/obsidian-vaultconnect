import { EventBus, EVENTS } from '../core/EventBus';
import { SyncResult } from '../services/SyncService';

/**
 * Error event data
 */
interface ErrorEventData {
  message?: string;
  error?: string;
}

/**
 * Status bar state
 */
export enum StatusBarState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  SYNCING = 'syncing',
  ERROR = 'error',
  OFFLINE = 'offline'
}

/**
 * Sync progress information
 */
export interface SyncProgress {
  current: number;
  total: number;
  currentFile: string;
  operation: 'upload' | 'download' | 'check';
}

/**
 * Status bar manager
 * Manages the status bar item and displays sync status
 */
export class StatusBarManager {
  private statusBarItem: HTMLElement;
  private eventBus: EventBus;
  private currentState: StatusBarState = StatusBarState.DISCONNECTED;
  private syncProgress: SyncProgress | null = null;
  private lastSyncTime: Date | null = null;
  private errorMessage: string | null = null;
  private onClickHandler: (() => void) | null = null;
  private isCrossTenant: boolean = false;
  private vaultPermission: 'read' | 'write' | 'admin' = 'admin';

  constructor(statusBarItem: HTMLElement, eventBus: EventBus) {
    this.statusBarItem = statusBarItem;
    this.eventBus = eventBus;
    
    this.setupEventListeners();
    this.updateDisplay();
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Connection events
    this.eventBus.on(EVENTS.CONNECTION_CHANGED, (connected: boolean) => {
      if (connected) {
        this.setState(StatusBarState.CONNECTED);
      } else {
        this.setState(StatusBarState.DISCONNECTED);
      }
    });

    this.eventBus.on(EVENTS.CONNECTION_ERROR, (error: ErrorEventData) => {
      this.setError(error.message || 'Connection error');
    });

    // Sync events
    this.eventBus.on(EVENTS.SYNC_STARTED, () => {
      this.setState(StatusBarState.SYNCING);
      this.syncProgress = null;
    });

    this.eventBus.on(EVENTS.SYNC_PROGRESS, (progress: SyncProgress) => {
      this.syncProgress = progress;
      this.updateDisplay();
    });

    this.eventBus.on(EVENTS.SYNC_COMPLETED, (result: SyncResult) => {
      this.lastSyncTime = new Date();
      this.syncProgress = null;
      this.setState(StatusBarState.CONNECTED);
    });

    this.eventBus.on(EVENTS.SYNC_ERROR, (error: ErrorEventData) => {
      this.syncProgress = null;
      this.setError(error.message || error.error || 'Sync error');
    });

    // Offline mode
    this.eventBus.on(EVENTS.OFFLINE_MODE_CHANGED, (offline: boolean) => {
      if (offline) {
        this.setState(StatusBarState.OFFLINE);
      } else {
        this.setState(StatusBarState.CONNECTED);
      }
    });
  }

  /**
   * Set status bar state
   */
  setState(state: StatusBarState): void {
    this.currentState = state;
    this.errorMessage = null;
    this.updateDisplay();
  }

  /**
   * Set error state
   */
  setError(message: string): void {
    this.currentState = StatusBarState.ERROR;
    this.errorMessage = message;
    this.updateDisplay();
  }

  /**
   * Set click handler
   */
  setClickHandler(handler: () => void): void {
    this.onClickHandler = handler;
    this.statusBarItem.style.cursor = 'pointer';
    this.statusBarItem.onclick = handler;
  }

  /**
   * Update status bar display
   */
  private updateDisplay(): void {
    const { icon, text, tooltip } = this.getDisplayInfo();
    
    this.statusBarItem.empty();
    
    // Create icon span
    const iconSpan = this.statusBarItem.createSpan({ cls: 'status-bar-item-icon' });
    iconSpan.setText(icon);
    
    // Create text span
    const textSpan = this.statusBarItem.createSpan({ cls: 'status-bar-item-text' });
    textSpan.setText(text);
    
    // Set tooltip
    this.statusBarItem.setAttribute('aria-label', tooltip);
    this.statusBarItem.title = tooltip;
    
    // Add state class
    this.statusBarItem.className = `status-bar-item plugin-vaultsync-status status-${this.currentState}`;
  }

  /**
   * Get display information based on current state
   */
  private getDisplayInfo(): { icon: string; text: string; tooltip: string } {
    switch (this.currentState) {
      case StatusBarState.DISCONNECTED:
        return {
          icon: '⚫',
          text: 'VaultSync',
          tooltip: 'VaultSync: Disconnected'
        };

      case StatusBarState.CONNECTING:
        return {
          icon: '🟡',
          text: 'VaultSync',
          tooltip: 'VaultSync: Connecting...'
        };

      case StatusBarState.CONNECTED:
        const crossTenantIndicator = this.getCrossTenantIndicator();
        const crossTenantTooltip = this.isCrossTenant 
          ? `\nCross-tenant vault (${this.vaultPermission})` 
          : '';
        
        if (this.lastSyncTime) {
          const timeAgo = this.getTimeAgo(this.lastSyncTime);
          return {
            icon: '🟢',
            text: `VaultSync${crossTenantIndicator}`,
            tooltip: `VaultSync: Connected${crossTenantTooltip}\nLast sync: ${timeAgo}`
          };
        }
        return {
          icon: '🟢',
          text: `VaultSync${crossTenantIndicator}`,
          tooltip: `VaultSync: Connected${crossTenantTooltip}`
        };

      case StatusBarState.SYNCING:
        if (this.syncProgress) {
          const percent = Math.round((this.syncProgress.current / this.syncProgress.total) * 100);
          return {
            icon: '🔄',
            text: `VaultSync (${percent}%)`,
            tooltip: `VaultSync: Syncing...\n${this.syncProgress.current}/${this.syncProgress.total} files\nCurrent: ${this.syncProgress.currentFile}`
          };
        }
        return {
          icon: '🔄',
          text: 'VaultSync',
          tooltip: 'VaultSync: Syncing...'
        };

      case StatusBarState.ERROR:
        return {
          icon: '🔴',
          text: 'VaultSync',
          tooltip: `VaultSync: Error\n${this.errorMessage || 'Unknown error'}`
        };

      case StatusBarState.OFFLINE:
        return {
          icon: '⚪',
          text: 'VaultSync',
          tooltip: 'VaultSync: Offline mode'
        };

      default:
        return {
          icon: '⚫',
          text: 'VaultSync',
          tooltip: 'VaultSync'
        };
    }
  }

  /**
   * Get time ago string
   */
  private getTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    
    if (seconds < 60) {
      return 'just now';
    }
    
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  /**
   * Get current state
   */
  getState(): StatusBarState {
    return this.currentState;
  }

  /**
   * Get last sync time
   */
  getLastSyncTime(): Date | null {
    return this.lastSyncTime;
  }

  /**
   * Set cross-tenant vault status
   */
  setCrossTenantStatus(isCrossTenant: boolean, permission: 'read' | 'write' | 'admin' = 'admin'): void {
    this.isCrossTenant = isCrossTenant;
    this.vaultPermission = permission;
    this.updateDisplay();
  }

  /**
   * Get cross-tenant indicator for display
   */
  private getCrossTenantIndicator(): string {
    if (!this.isCrossTenant) {
      return '';
    }
    
    if (this.vaultPermission === 'read') {
      return ' 🔗👁️';
    } else if (this.vaultPermission === 'write') {
      return ' 🔗✏️';
    } else {
      return ' 🔗';
    }
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.statusBarItem.onclick = null;
  }
}
