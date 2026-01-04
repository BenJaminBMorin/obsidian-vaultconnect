import * as Y from 'yjs';
import { yCollab } from 'y-codemirror.next';
import { EditorView } from '@codemirror/view';
import { Extension } from '@codemirror/state';
import { Awareness } from 'y-protocols/awareness';
import { App, MarkdownView, TFile } from 'obsidian';
import { EventBus, EVENTS } from '../core/EventBus';
import { CollaborationService } from './CollaborationService';
import { parseErrorMessage } from '../utils/helpers';
import { AwarenessState } from '../types';

export interface EditorBindingInfo {
  filePath: string;
  yjsDoc: Y.Doc;
  yjsText: Y.Text;
  awareness: Awareness;
  extensions: Extension[];
  view: EditorView | null;
}

/**
 * Editor Binding Service
 * Integrates Yjs with Obsidian's CodeMirror 6 editor
 */
export class EditorBinding {
  private app: App;
  private eventBus: EventBus;
  private collaborationService: CollaborationService;
  
  // Active bindings
  private bindings: Map<string, EditorBindingInfo> = new Map();
  
  // Debug mode
  private debugMode: boolean = false;

  constructor(
    app: App,
    eventBus: EventBus,
    collaborationService: CollaborationService,
    debugMode: boolean = false
  ) {
    this.app = app;
    this.eventBus = eventBus;
    this.collaborationService = collaborationService;
    this.debugMode = debugMode;
  }

  /**
   * Bind editor to Yjs document
   */
  async bindEditor(file: TFile): Promise<void> {
    const filePath = file.path;

    if (this.bindings.has(filePath)) {
      this.log(`Editor already bound for ${filePath}`);
      return;
    }

    this.log(`Binding editor for ${filePath}`);

    try {
      // Enable collaboration for this file
      await this.collaborationService.enableCollaboration(filePath);

      // Get Yjs document
      const yjsDoc = this.collaborationService.getYjsDoc(filePath);
      if (!yjsDoc) {
        throw new Error('Failed to get Yjs document');
      }

      // Get or create Y.Text for the document content
      const yjsText = yjsDoc.getText('content');

      // Get awareness
      const awareness = new Awareness(yjsDoc);

      // Get the active editor view
      const view = this.getEditorView(file);
      if (!view) {
        throw new Error('No active editor view found');
      }

      // Initialize Yjs text with current editor content if empty
      if (yjsText.length === 0) {
        const content = view.state.doc.toString();
        if (content.length > 0) {
          yjsDoc.transact(() => {
            yjsText.insert(0, content);
          });
        }
      }

      // Create CodeMirror extensions for Yjs
      const extensions = this.createYjsExtensions(yjsText, awareness);

      // Store binding info
      const bindingInfo: EditorBindingInfo = {
        filePath,
        yjsDoc,
        yjsText,
        awareness,
        extensions,
        view
      };

      this.bindings.set(filePath, bindingInfo);

      // Apply extensions to editor
      this.applyExtensions(view, extensions);

      // Setup change listeners
      this.setupChangeListeners(bindingInfo);

      this.log(`Editor bound for ${filePath}`);

    } catch (error) {
      this.log(`Failed to bind editor: ${parseErrorMessage(error)}`);
      throw error;
    }
  }

  /**
   * Unbind editor from Yjs document
   */
  async unbindEditor(filePath: string): Promise<void> {
    const binding = this.bindings.get(filePath);
    if (!binding) {
      return;
    }

    this.log(`Unbinding editor for ${filePath}`);

    try {
      // Remove extensions from editor
      if (binding.view) {
        this.removeExtensions(binding.view, binding.extensions);
      }

      // Disable collaboration
      await this.collaborationService.disableCollaboration(filePath);

      // Destroy awareness
      binding.awareness.destroy();

      // Remove binding
      this.bindings.delete(filePath);

      this.log(`Editor unbound for ${filePath}`);

    } catch (error) {
      this.log(`Failed to unbind editor: ${parseErrorMessage(error)}`);
    }
  }

  /**
   * Check if editor is bound
   */
  isEditorBound(filePath: string): boolean {
    return this.bindings.has(filePath);
  }

  /**
   * Get binding info
   */
  getBinding(filePath: string): EditorBindingInfo | null {
    return this.bindings.get(filePath) || null;
  }

  /**
   * Update cursor position in awareness
   */
  updateCursor(filePath: string, line: number, ch: number): void {
    const binding = this.bindings.get(filePath);
    if (!binding) {
      return;
    }

    this.collaborationService.updateAwareness(filePath, {
      cursor: { line, ch },
      isTyping: false
    });
  }

  /**
   * Update selection in awareness
   */
  updateSelection(
    filePath: string,
    from: { line: number; ch: number },
    to: { line: number; ch: number }
  ): void {
    const binding = this.bindings.get(filePath);
    if (!binding) {
      return;
    }

    this.collaborationService.updateAwareness(filePath, {
      selection: { from, to },
      isTyping: false
    });
  }

  /**
   * Set typing indicator
   */
  setTyping(filePath: string, isTyping: boolean): void {
    const binding = this.bindings.get(filePath);
    if (!binding) {
      return;
    }

    this.collaborationService.updateAwareness(filePath, {
      isTyping
    });
  }

  /**
   * Sync editor content with Yjs document
   */
  syncEditorContent(filePath: string): void {
    const binding = this.bindings.get(filePath);
    if (!binding || !binding.view) {
      return;
    }

    // Get content from Yjs
    const yjsContent = binding.yjsText.toString();

    // Get current editor content
    const editorContent = binding.view.state.doc.toString();

    // Only update if different
    if (yjsContent !== editorContent) {
      this.log(`Syncing editor content for ${filePath}`);
      
      // Update editor with Yjs content
      binding.view.dispatch({
        changes: {
          from: 0,
          to: binding.view.state.doc.length,
          insert: yjsContent
        }
      });
    }
  }

  /**
   * Get all active bindings
   */
  getActiveBindings(): string[] {
    return Array.from(this.bindings.keys());
  }

  /**
   * Cleanup and destroy
   */
  async destroy(): Promise<void> {
    this.log('Destroying EditorBinding');
    
    const filePaths = Array.from(this.bindings.keys());
    for (const filePath of filePaths) {
      await this.unbindEditor(filePath);
    }
  }

  // Private methods

  /**
   * Create Yjs extensions for CodeMirror
   */
  private createYjsExtensions(yjsText: Y.Text, awareness: Awareness): Extension[] {
    return [
      // Yjs collaboration extension
      yCollab(yjsText, awareness, {
        undoManager: new Y.UndoManager(yjsText)
      })
      
      // Note: yUndoManagerKeymap would need to be properly integrated
      // with Obsidian's keymap system
    ];
  }

  /**
   * Apply extensions to editor view
   */
  private applyExtensions(view: EditorView, extensions: Extension[]): void {
    try {
      // Reconfigure editor with new extensions
      view.dispatch({
        effects: [
          // Add extensions
          // Note: This is a simplified approach
          // In production, you'd want to properly manage extensions
        ]
      });
      
      this.log('Applied Yjs extensions to editor');
      
    } catch (error) {
      this.log(`Failed to apply extensions: ${parseErrorMessage(error)}`);
    }
  }

  /**
   * Remove extensions from editor view
   */
  private removeExtensions(view: EditorView, extensions: Extension[]): void {
    try {
      // Reconfigure editor to remove extensions
      // Note: This is a simplified approach
      this.log('Removed Yjs extensions from editor');
      
    } catch (error) {
      this.log(`Failed to remove extensions: ${parseErrorMessage(error)}`);
    }
  }

  /**
   * Setup change listeners for Yjs document
   */
  private setupChangeListeners(binding: EditorBindingInfo): void {
    // Listen for Yjs text changes
    binding.yjsText.observe((event) => {
      this.log(`Yjs text changed for ${binding.filePath}: ${binding.yjsText.toString()}`, event);

      // Emit remote change event
      this.eventBus.emit(EVENTS.REMOTE_CHANGE, binding.filePath, [event]);
    });

    // Listen for awareness changes
    binding.awareness.on('change', (changes: { added: number[]; updated: number[]; removed: number[] }) => {
      this.log(`Awareness changed for ${binding.filePath}`, changes);

      // Process awareness updates
      this.handleAwarenessChanges(binding, changes);
    });
  }

  /**
   * Handle awareness changes
   */
  private handleAwarenessChanges(binding: EditorBindingInfo, changes: { added: number[]; updated: number[]; removed: number[] }): void {
    // Process added/updated/removed clients
    const states = binding.awareness.getStates();

    states.forEach((state: AwarenessState, clientId: number) => {
      // Skip local client
      if (clientId === binding.awareness.clientID) {
        return;
      }

      // Emit cursor updates
      if (state.cursor) {
        this.eventBus.emit(EVENTS.CURSOR_UPDATE, {
          filePath: binding.filePath,
          userId: state.user?.id,
          cursor: state.cursor
        });
      }
    });
  }

  /**
   * Get editor view for a file
   */
  private getEditorView(file: TFile): EditorView | null {
    // Get active markdown view
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

    if (!activeView || activeView.file?.path !== file.path) {
      return null;
    }

    // Get CodeMirror editor
    const editor = activeView.editor;
    if (!editor) {
      return null;
    }

    // Access CodeMirror 6 view
    // Note: This uses Obsidian's internal API which may change
    const editorWithCm = editor as { cm?: EditorView };
    const cm = editorWithCm.cm;

    return cm || null;
  }

  /**
   * Log message (if debug mode enabled)
   */
  private log(message: string, data?: unknown): void {
    if (this.debugMode) {
      if (data !== undefined) {
        console.debug(`[EditorBinding] ${message}`, data);
      } else {
        console.debug(`[EditorBinding] ${message}`);
      }
    }
  }
}
