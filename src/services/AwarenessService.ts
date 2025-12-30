import { Awareness } from 'y-protocols/awareness';
import { App, MarkdownView, EditorPosition } from 'obsidian';
import { EventBus, EVENTS } from '../core/EventBus';
import { CollaborationService } from './CollaborationService';
import { AwarenessState } from '../types';
import { parseErrorMessage } from '../utils/helpers';

export interface RemoteCursor {
  userId: string;
  userName: string;
  color: string;
  position: EditorPosition;
}

export interface RemoteSelection {
  userId: string;
  userName: string;
  color: string;
  from: EditorPosition;
  to: EditorPosition;
}

/**
 * Awareness Service
 * Manages user awareness state (cursor, selection) and broadcasts updates
 */
export class AwarenessService {
  private app: App;
  private eventBus: EventBus;
  private collaborationService: CollaborationService;
  
  // User info
  private userId: string;
  private userName: string;
  private userColor: string;
  
  // Active file tracking
  private activeFile: string | null = null;
  
  // Cursor/selection tracking
  private lastCursorUpdate: number = 0;
  private lastSelectionUpdate: number = 0;
  private updateThrottleMs: number = 100; // Throttle updates to 100ms
  
  // Typing indicator
  private typingTimeout: NodeJS.Timeout | null = null;
  private typingTimeoutMs: number = 2000; // 2 seconds
  
  // Remote cursors and selections
  private remoteCursors: Map<string, RemoteCursor> = new Map();
  private remoteSelections: Map<string, RemoteSelection> = new Map();
  
  // Debug mode
  private debugMode: boolean = false;

  constructor(
    app: App,
    eventBus: EventBus,
    collaborationService: CollaborationService,
    userId: string,
    userName: string,
    userColor: string,
    debugMode: boolean = false
  ) {
    this.app = app;
    this.eventBus = eventBus;
    this.collaborationService = collaborationService;
    this.userId = userId;
    this.userName = userName;
    this.userColor = userColor;
    this.debugMode = debugMode;
    
    // Setup event listeners
    this.setupEventListeners();
  }

  /**
   * Initialize awareness service
   */
  async initialize(): Promise<void> {
    this.log('Initializing AwarenessService');
    
    // Register editor change listeners
    this.registerEditorListeners();
    
    this.log('AwarenessService initialized');
  }

  /**
   * Set active file
   */
  setActiveFile(filePath: string | null): void {
    if (this.activeFile === filePath) {
      return;
    }

    this.log(`Active file changed: ${filePath}`);
    
    // Clear awareness for old file
    if (this.activeFile) {
      this.clearAwareness(this.activeFile);
    }

    this.activeFile = filePath;

    // Broadcast presence for new file
    if (filePath) {
      this.broadcastPresence(filePath);
    }
  }

  /**
   * Broadcast user presence
   */
  broadcastPresence(filePath: string): void {
    this.collaborationService.updateAwareness(filePath, {
      user: {
        id: this.userId,
        name: this.userName,
        color: this.userColor
      },
      cursor: undefined,
      selection: undefined,
      isTyping: false
    });

    this.log(`Broadcasted presence for ${filePath}`);
  }

  /**
   * Update cursor position
   */
  updateCursor(filePath: string, line: number, ch: number): void {
    // Throttle updates
    const now = Date.now();
    if (now - this.lastCursorUpdate < this.updateThrottleMs) {
      return;
    }
    this.lastCursorUpdate = now;

    // Update awareness
    this.collaborationService.updateAwareness(filePath, {
      cursor: { line, ch },
      isTyping: false
    });

    this.log(`Updated cursor: ${line}:${ch}`);
  }

  /**
   * Update selection
   */
  updateSelection(
    filePath: string,
    from: { line: number; ch: number },
    to: { line: number; ch: number }
  ): void {
    // Throttle updates
    const now = Date.now();
    if (now - this.lastSelectionUpdate < this.updateThrottleMs) {
      return;
    }
    this.lastSelectionUpdate = now;

    // Update awareness
    this.collaborationService.updateAwareness(filePath, {
      selection: { from, to },
      isTyping: false
    });

    this.log(`Updated selection: ${from.line}:${from.ch} - ${to.line}:${to.ch}`);
  }

  /**
   * Set typing indicator
   */
  setTyping(filePath: string, isTyping: boolean): void {
    // Clear existing timeout
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
      this.typingTimeout = null;
    }

    // Update awareness
    this.collaborationService.updateAwareness(filePath, {
      isTyping
    });

    // Auto-clear typing indicator after timeout
    if (isTyping) {
      this.typingTimeout = setTimeout(() => {
        this.collaborationService.updateAwareness(filePath, {
          isTyping: false
        });
        this.typingTimeout = null;
      }, this.typingTimeoutMs);
    }

    this.log(`Typing indicator: ${isTyping}`);
  }

  /**
   * Clear awareness for a file
   */
  clearAwareness(filePath: string): void {
    this.collaborationService.updateAwareness(filePath, {
      cursor: undefined,
      selection: undefined,
      isTyping: false
    });

    this.log(`Cleared awareness for ${filePath}`);
  }

  /**
   * Get remote cursors for active file
   */
  getRemoteCursors(): RemoteCursor[] {
    return Array.from(this.remoteCursors.values());
  }

  /**
   * Get remote selections for active file
   */
  getRemoteSelections(): RemoteSelection[] {
    return Array.from(this.remoteSelections.values());
  }

  /**
   * Get awareness states for a file
   */
  getAwarenessStates(filePath: string): Map<number, AwarenessState> {
    return this.collaborationService.getAwarenessStates(filePath);
  }

  /**
   * Assign unique color to user
   */
  static generateUserColor(userId: string): string {
    // Generate color based on user ID hash
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = userId.charCodeAt(i) + ((hash << 5) - hash);
    }

    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
      '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2',
      '#F8B739', '#52B788', '#E76F51', '#2A9D8F',
      '#E63946', '#F1FAEE', '#A8DADC', '#457B9D',
      '#1D3557', '#F4A261', '#E76F51', '#2A9D8F'
    ];

    const index = Math.abs(hash) % colors.length;
    return colors[index];
  }

  /**
   * Cleanup and destroy
   */
  destroy(): void {
    this.log('Destroying AwarenessService');
    
    // Clear typing timeout
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
      this.typingTimeout = null;
    }

    // Clear awareness for active file
    if (this.activeFile) {
      this.clearAwareness(this.activeFile);
    }

    // Clear remote cursors and selections
    this.remoteCursors.clear();
    this.remoteSelections.clear();
  }

  // Private methods

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen for remote cursor updates
    this.eventBus.on(EVENTS.YJS_REMOTE_CURSOR, (data: any) => {
      this.handleRemoteCursor(data);
    });

    // Listen for remote selection updates
    this.eventBus.on(EVENTS.YJS_REMOTE_SELECTION, (data: any) => {
      this.handleRemoteSelection(data);
    });

    // Listen for collaborator left events
    this.eventBus.on(EVENTS.COLLABORATOR_LEFT, (userId: string) => {
      this.handleCollaboratorLeft(userId);
    });
  }

  /**
   * Register editor change listeners
   */
  private registerEditorListeners(): void {
    // Listen for active leaf changes
    this.app.workspace.on('active-leaf-change', () => {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView && activeView.file) {
        this.setActiveFile(activeView.file.path);
      } else {
        this.setActiveFile(null);
      }
    });

    // Listen for editor changes
    this.app.workspace.on('editor-change', (editor) => {
      if (!this.activeFile) {
        return;
      }

      // Get cursor position
      const cursor = editor.getCursor();
      this.updateCursor(this.activeFile, cursor.line, cursor.ch);

      // Set typing indicator
      this.setTyping(this.activeFile, true);
    });
  }

  /**
   * Handle remote cursor update
   */
  private handleRemoteCursor(data: any): void {
    const { filePath, userId, cursor } = data;

    // Skip if not active file
    if (filePath !== this.activeFile) {
      return;
    }

    // Get user info from awareness
    const awarenessStates = this.getAwarenessStates(filePath);
    let userName = 'Unknown';
    let color = '#000000';

    awarenessStates.forEach((state: AwarenessState) => {
      if (state.user.id === userId) {
        userName = state.user.name;
        color = state.user.color;
      }
    });

    // Update remote cursor
    this.remoteCursors.set(userId, {
      userId,
      userName,
      color,
      position: { line: cursor.line, ch: cursor.ch }
    });

    this.log(`Remote cursor updated: ${userName} at ${cursor.line}:${cursor.ch}`);

    // Emit event for UI update
    this.eventBus.emit(EVENTS.CURSOR_UPDATE, {
      userId,
      userName,
      color,
      position: cursor
    });
  }

  /**
   * Handle remote selection update
   */
  private handleRemoteSelection(data: any): void {
    const { filePath, userId, selection } = data;

    // Skip if not active file
    if (filePath !== this.activeFile) {
      return;
    }

    // Get user info from awareness
    const awarenessStates = this.getAwarenessStates(filePath);
    let userName = 'Unknown';
    let color = '#000000';

    awarenessStates.forEach((state: AwarenessState) => {
      if (state.user.id === userId) {
        userName = state.user.name;
        color = state.user.color;
      }
    });

    // Update remote selection
    this.remoteSelections.set(userId, {
      userId,
      userName,
      color,
      from: { line: selection.from.line, ch: selection.from.ch },
      to: { line: selection.to.line, ch: selection.to.ch }
    });

    this.log(`Remote selection updated: ${userName}`);

    // Emit event for UI update
    this.eventBus.emit('selection-update', {
      userId,
      userName,
      color,
      selection
    });
  }

  /**
   * Handle collaborator left
   */
  private handleCollaboratorLeft(userId: string): void {
    // Remove remote cursor
    this.remoteCursors.delete(userId);

    // Remove remote selection
    this.remoteSelections.delete(userId);

    this.log(`Collaborator left: ${userId}`);
  }

  /**
   * Log message (if debug mode enabled)
   */
  private log(message: string, data?: any): void {
    if (this.debugMode) {
      if (data !== undefined) {
        console.debug(`[AwarenessService] ${message}`, data);
      } else {
        console.debug(`[AwarenessService] ${message}`);
      }
    }
  }
}
