import { App, MarkdownView, EditorPosition } from 'obsidian';
import { EventBus, EVENTS } from '../core/EventBus';
import { AwarenessService, RemoteCursor, RemoteSelection } from '../services/AwarenessService';
import { CollaborationService } from '../services/CollaborationService';

/**
 * Collaboration UI
 * Displays cursor positions, selections, typing indicators, and collaborator info
 */
export class CollaborationUI {
  private app: App;
  private eventBus: EventBus;
  private awarenessService: AwarenessService;
  private collaborationService: CollaborationService;
  
  // UI elements
  private cursorWidgets: Map<string, HTMLElement> = new Map();
  private selectionWidgets: Map<string, HTMLElement> = new Map();
  private typingIndicators: Map<string, HTMLElement> = new Map();
  private presenceIndicators: Map<string, HTMLElement> = new Map();
  
  // Active file
  private activeFile: string | null = null;
  
  // Debug mode
  private debugMode: boolean = false;

  constructor(
    app: App,
    eventBus: EventBus,
    awarenessService: AwarenessService,
    collaborationService: CollaborationService,
    debugMode: boolean = false
  ) {
    this.app = app;
    this.eventBus = eventBus;
    this.awarenessService = awarenessService;
    this.collaborationService = collaborationService;
    this.debugMode = debugMode;
    
    // Setup event listeners
    this.setupEventListeners();
  }

  /**
   * Initialize UI
   */
  initialize(): void {
    this.log('Initializing CollaborationUI');
    
    // Register workspace events
    this.app.workspace.on('active-leaf-change', () => {
      this.handleActiveFileChange();
    });
    
    this.log('CollaborationUI initialized');
  }

  /**
   * Display cursor position
   */
  displayCursor(cursor: RemoteCursor): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      return;
    }

    // Remove existing cursor widget
    this.removeCursor(cursor.userId);

    // Create cursor widget
    const widget = this.createCursorWidget(cursor);
    
    // Position cursor in editor
    this.positionCursorWidget(widget, cursor.position, activeView);
    
    // Store widget
    this.cursorWidgets.set(cursor.userId, widget);
    
    this.log(`Displayed cursor for ${cursor.userName}`);
  }

  /**
   * Remove cursor
   */
  removeCursor(userId: string): void {
    const widget = this.cursorWidgets.get(userId);
    if (widget) {
      widget.remove();
      this.cursorWidgets.delete(userId);
    }
  }

  /**
   * Display selection highlight
   */
  displaySelection(selection: RemoteSelection): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      return;
    }

    // Remove existing selection widget
    this.removeSelection(selection.userId);

    // Create selection widget
    const widget = this.createSelectionWidget(selection);
    
    // Position selection in editor
    this.positionSelectionWidget(widget, selection.from, selection.to, activeView);
    
    // Store widget
    this.selectionWidgets.set(selection.userId, widget);
    
    this.log(`Displayed selection for ${selection.userName}`);
  }

  /**
   * Remove selection
   */
  removeSelection(userId: string): void {
    const widget = this.selectionWidgets.get(userId);
    if (widget) {
      widget.remove();
      this.selectionWidgets.delete(userId);
    }
  }

  /**
   * Display typing indicator
   */
  displayTypingIndicator(userId: string, userName: string, color: string): void {
    // Remove existing indicator
    this.removeTypingIndicator(userId);

    // Create typing indicator
    const indicator = this.createTypingIndicator(userName, color);
    
    // Add to status bar or editor
    const statusBar = document.querySelector('.status-bar');
    if (statusBar) {
      statusBar.appendChild(indicator);
    }
    
    // Store indicator
    this.typingIndicators.set(userId, indicator);
    
    this.log(`Displayed typing indicator for ${userName}`);
  }

  /**
   * Remove typing indicator
   */
  removeTypingIndicator(userId: string): void {
    const indicator = this.typingIndicators.get(userId);
    if (indicator) {
      indicator.remove();
      this.typingIndicators.delete(userId);
    }
  }

  /**
   * Display presence indicator in file list
   */
  displayPresenceIndicator(filePath: string, collaborators: string[]): void {
    // Find file item in file explorer
    const fileItem = this.findFileItem(filePath);
    if (!fileItem) {
      return;
    }

    // Remove existing indicator
    this.removePresenceIndicator(filePath);

    // Create presence indicator
    const indicator = this.createPresenceIndicator(collaborators);
    
    // Add to file item
    fileItem.appendChild(indicator);
    
    // Store indicator
    this.presenceIndicators.set(filePath, indicator);
    
    this.log(`Displayed presence indicator for ${filePath}`);
  }

  /**
   * Remove presence indicator
   */
  removePresenceIndicator(filePath: string): void {
    const indicator = this.presenceIndicators.get(filePath);
    if (indicator) {
      indicator.remove();
      this.presenceIndicators.delete(filePath);
    }
  }

  /**
   * Clear all UI elements
   */
  clearAll(): void {
    // Clear cursors
    this.cursorWidgets.forEach((widget) => widget.remove());
    this.cursorWidgets.clear();

    // Clear selections
    this.selectionWidgets.forEach((widget) => widget.remove());
    this.selectionWidgets.clear();

    // Clear typing indicators
    this.typingIndicators.forEach((indicator) => indicator.remove());
    this.typingIndicators.clear();

    // Clear presence indicators
    this.presenceIndicators.forEach((indicator) => indicator.remove());
    this.presenceIndicators.clear();
    
    this.log('Cleared all UI elements');
  }

  /**
   * Cleanup and destroy
   */
  destroy(): void {
    this.log('Destroying CollaborationUI');
    this.clearAll();
  }

  // Private methods

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen for cursor updates
    this.eventBus.on(EVENTS.CURSOR_UPDATE, (data: any) => {
      const cursor: RemoteCursor = {
        userId: data.userId,
        userName: data.userName,
        color: data.color,
        position: data.position
      };
      this.displayCursor(cursor);
    });

    // Listen for collaborator left
    this.eventBus.on(EVENTS.COLLABORATOR_LEFT, (userId: string) => {
      this.removeCursor(userId);
      this.removeSelection(userId);
      this.removeTypingIndicator(userId);
    });

    // Listen for awareness updates
    this.eventBus.on(EVENTS.YJS_AWARENESS_UPDATED, (data: any) => {
      this.handleAwarenessUpdate(data);
    });
  }

  /**
   * Handle active file change
   */
  private handleActiveFileChange(): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    
    if (activeView && activeView.file) {
      this.activeFile = activeView.file.path;
      this.refreshUI();
    } else {
      this.activeFile = null;
      this.clearAll();
    }
  }

  /**
   * Handle awareness update
   */
  private handleAwarenessUpdate(data: any): void {
    if (data.filePath !== this.activeFile) {
      return;
    }

    // Refresh UI to show updated awareness states
    this.refreshUI();
  }

  /**
   * Refresh UI
   */
  private refreshUI(): void {
    if (!this.activeFile) {
      return;
    }

    // Get remote cursors
    const cursors = this.awarenessService.getRemoteCursors();
    cursors.forEach((cursor) => {
      this.displayCursor(cursor);
    });

    // Get remote selections
    const selections = this.awarenessService.getRemoteSelections();
    selections.forEach((selection) => {
      this.displaySelection(selection);
    });

    // Get collaborators
    const collaborators = this.collaborationService.getFileCollaborators(this.activeFile);
    
    // Update typing indicators
    collaborators.forEach((collaborator) => {
      if (collaborator.status === 'active') {
        this.displayTypingIndicator(
          collaborator.userId,
          collaborator.userName,
          collaborator.color
        );
      } else {
        this.removeTypingIndicator(collaborator.userId);
      }
    });
  }

  /**
   * Create cursor widget
   */
  private createCursorWidget(cursor: RemoteCursor): HTMLElement {
    const widget = document.createElement('div');
    widget.className = 'collab-cursor';
    widget.style.position = 'absolute';
    widget.style.width = '2px';
    widget.style.height = '1.2em';
    widget.style.backgroundColor = cursor.color;
    widget.style.zIndex = '1000';
    widget.style.pointerEvents = 'none';

    // Add user name label
    const label = document.createElement('div');
    label.className = 'collab-cursor-label';
    label.textContent = cursor.userName;
    label.style.position = 'absolute';
    label.style.top = '-20px';
    label.style.left = '0';
    label.style.backgroundColor = cursor.color;
    label.style.color = '#fff';
    label.style.padding = '2px 6px';
    label.style.borderRadius = '3px';
    label.style.fontSize = '11px';
    label.style.whiteSpace = 'nowrap';
    label.style.pointerEvents = 'none';

    widget.appendChild(label);

    return widget;
  }

  /**
   * Position cursor widget in editor
   */
  private positionCursorWidget(
    widget: HTMLElement,
    position: EditorPosition,
    view: MarkdownView
  ): void {
    const editor = view.editor;
    const coords = editor.posToOffset(position);
    
    // Get editor container
    const editorEl = view.contentEl.querySelector('.cm-editor');
    if (!editorEl) {
      return;
    }

    // Position widget
    widget.style.left = `${coords}px`;
    widget.style.top = `${position.line * 20}px`; // Approximate line height

    // Add to editor
    editorEl.appendChild(widget);
  }

  /**
   * Create selection widget
   */
  private createSelectionWidget(selection: RemoteSelection): HTMLElement {
    const widget = document.createElement('div');
    widget.className = 'collab-selection';
    widget.style.position = 'absolute';
    widget.style.backgroundColor = selection.color;
    widget.style.opacity = '0.3';
    widget.style.zIndex = '999';
    widget.style.pointerEvents = 'none';

    return widget;
  }

  /**
   * Position selection widget in editor
   */
  private positionSelectionWidget(
    widget: HTMLElement,
    from: EditorPosition,
    to: EditorPosition,
    view: MarkdownView
  ): void {
    const editor = view.editor;
    
    // Get editor container
    const editorEl = view.contentEl.querySelector('.cm-editor');
    if (!editorEl) {
      return;
    }

    // Calculate selection bounds
    const fromOffset = editor.posToOffset(from);
    const toOffset = editor.posToOffset(to);

    // Position widget
    widget.style.left = `${fromOffset}px`;
    widget.style.top = `${from.line * 20}px`;
    widget.style.width = `${toOffset - fromOffset}px`;
    widget.style.height = `${(to.line - from.line + 1) * 20}px`;

    // Add to editor
    editorEl.appendChild(widget);
  }

  /**
   * Create typing indicator
   */
  private createTypingIndicator(userName: string, color: string): HTMLElement {
    const indicator = document.createElement('div');
    indicator.className = 'collab-typing-indicator';
    indicator.style.display = 'inline-block';
    indicator.style.marginLeft = '10px';
    indicator.style.padding = '2px 8px';
    indicator.style.backgroundColor = color;
    indicator.style.color = '#fff';
    indicator.style.borderRadius = '3px';
    indicator.style.fontSize = '11px';
    indicator.textContent = `${userName} is typing...`;

    return indicator;
  }

  /**
   * Create presence indicator
   */
  private createPresenceIndicator(collaborators: string[]): HTMLElement {
    const indicator = document.createElement('div');
    indicator.className = 'collab-presence-indicator';
    indicator.style.display = 'inline-block';
    indicator.style.marginLeft = '5px';
    indicator.style.padding = '2px 6px';
    indicator.style.backgroundColor = '#4ECDC4';
    indicator.style.color = '#fff';
    indicator.style.borderRadius = '50%';
    indicator.style.fontSize = '10px';
    indicator.style.fontWeight = 'bold';
    indicator.textContent = collaborators.length.toString();
    indicator.title = `${collaborators.join(', ')} viewing this file`;

    return indicator;
  }

  /**
   * Find file item in file explorer
   */
  private findFileItem(filePath: string): HTMLElement | null {
    // This is a simplified approach
    // In production, you'd need to properly traverse the file explorer DOM
    const fileExplorer = document.querySelector('.nav-files-container');
    if (!fileExplorer) {
      return null;
    }

    // Find file item by data attribute or text content
    const fileItems = fileExplorer.querySelectorAll('.nav-file');
    for (const item of Array.from(fileItems)) {
      const titleEl = item.querySelector('.nav-file-title');
      if (titleEl && titleEl.getAttribute('data-path') === filePath) {
        return item as HTMLElement;
      }
    }

    return null;
  }

  /**
   * Log message (if debug mode enabled)
   */
  private log(message: string, data?: any): void {
    if (this.debugMode) {
      if (data !== undefined) {
        console.debug(`[CollaborationUI] ${message}`, data);
      } else {
        console.debug(`[CollaborationUI] ${message}`);
      }
    }
  }
}
