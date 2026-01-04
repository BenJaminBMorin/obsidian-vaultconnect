/**
 * Event Bus for plugin-wide event communication
 */

type EventCallback = (...args: unknown[]) => void;

export class EventBus {
  private events: Map<string, Set<EventCallback>> = new Map();

  /**
   * Subscribe to an event
   */
  on(event: string, callback: EventCallback): () => void {
    if (!this.events.has(event)) {
      this.events.set(event, new Set());
    }

    this.events.get(event)!.add(callback);

    // Return unsubscribe function
    return () => this.off(event, callback);
  }

  /**
   * Subscribe to an event (one-time)
   */
  once(event: string, callback: EventCallback): () => void {
    const wrappedCallback = (...args: unknown[]) => {
      callback(...args);
      this.off(event, wrappedCallback);
    };

    return this.on(event, wrappedCallback);
  }

  /**
   * Unsubscribe from an event
   */
  off(event: string, callback: EventCallback): void {
    const callbacks = this.events.get(event);
    if (callbacks) {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.events.delete(event);
      }
    }
  }

  /**
   * Emit an event
   */
  emit(event: string, ...args: unknown[]): void {
    const callbacks = this.events.get(event);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(...args);
        } catch (error) {
          console.error(`Error in event handler for "${event}":`, error);
        }
      });
    }
  }

  /**
   * Clear all event listeners
   */
  clear(): void {
    this.events.clear();
  }

  /**
   * Get number of listeners for an event
   */
  listenerCount(event: string): number {
    return this.events.get(event)?.size || 0;
  }

  /**
   * Get all event names
   */
  eventNames(): string[] {
    return Array.from(this.events.keys());
  }
}

// Event names
export const EVENTS = {
  // Authentication
  AUTH_STATE_CHANGED: 'auth:state-changed',
  AUTH_TOKEN_EXPIRED: 'auth:token-expired',
  
  // Vault
  VAULT_CHANGED: 'vault:changed',
  VAULT_STATS_UPDATED: 'vault:stats-updated',
  
  // Sync
  SYNC_STARTED: 'sync:started',
  SYNC_PROGRESS: 'sync:progress',
  SYNC_COMPLETED: 'sync:completed',
  SYNC_ERROR: 'sync:error',
  SYNC_MODE_CHANGED: 'sync:mode-changed',
  SYNC_DRIFT_DETECTED: 'sync:drift-detected',
  FILE_SYNCED: 'sync:file-synced',
  
  // Conflicts
  CONFLICT_DETECTED: 'conflict:detected',
  CONFLICT_RESOLVED: 'conflict:resolved',
  
  // Connection
  CONNECTION_CHANGED: 'connection:changed',
  CONNECTION_ERROR: 'connection:error',
  
  // Presence
  USER_JOINED: 'presence:user-joined',
  USER_LEFT: 'presence:user-left',
  USER_ACTIVITY: 'presence:user-activity',
  FILE_OPENED: 'presence:file-opened',
  FILE_CLOSED: 'presence:file-closed',
  
  // Collaboration
  COLLABORATOR_JOINED: 'collab:joined',
  COLLABORATOR_LEFT: 'collab:left',
  REMOTE_CHANGE: 'collab:remote-change',
  CURSOR_UPDATE: 'collab:cursor-update',
  
  // Offline
  OFFLINE_MODE_CHANGED: 'offline:mode-changed',
  QUEUE_UPDATED: 'offline:queue-updated',
  
  // Selective Sync
  SELECTIVE_SYNC_CHANGED: 'selective-sync:changed',
  
  // Yjs / Real-time Collaboration
  YJS_PROVIDER_STATUS: 'yjs:provider-status',
  YJS_DOCUMENT_SYNCED: 'yjs:document-synced',
  YJS_PROVIDER_DISCONNECTED: 'yjs:provider-disconnected',
  YJS_PROVIDER_ERROR: 'yjs:provider-error',
  YJS_AWARENESS_UPDATED: 'yjs:awareness-updated',
  YJS_REMOTE_CURSOR: 'yjs:remote-cursor',
  YJS_REMOTE_SELECTION: 'yjs:remote-selection',
  
  // Upload
  UPLOAD_STARTED: 'upload:started',
  UPLOAD_PROGRESS: 'upload:progress',
  UPLOAD_COMPLETED: 'upload:completed',
  UPLOAD_FAILED: 'upload:failed',
  UPLOAD_PAUSED: 'upload:paused',
  UPLOAD_RESUMED: 'upload:resumed',
  UPLOAD_CANCELLED: 'upload:cancelled',
  
  // Error Handling
  AUTH_ERROR: 'error:auth',
  WEBSOCKET_ERROR: 'error:websocket',
  NETWORK_ERROR: 'error:network',
  STORAGE_ERROR: 'error:storage',
  VALIDATION_ERROR: 'error:validation',
  FILE_ERROR: 'error:file',
  COLLABORATION_ERROR: 'error:collaboration',
  SHOW_CONFLICT_MODAL: 'ui:show-conflict-modal'
};
