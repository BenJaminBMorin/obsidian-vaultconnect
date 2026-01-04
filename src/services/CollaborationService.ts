import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { App, TFile } from 'obsidian';
import { EventBus, EVENTS } from '../core/EventBus';
import { YjsProvider, YjsDocumentInfo } from './YjsProvider';
import { AuthService } from './AuthService';
import { parseErrorMessage } from '../utils/helpers';
import { AwarenessState } from '../types';

export interface CollaboratorInfo {
  userId: string;
  userName: string;
  userAvatar?: string;
  color: string;
  currentFile: string | null;
  status: 'active' | 'away';
  lastSeen: Date;
}

/**
 * Collaboration Service
 * Manages real-time collaborative editing using Yjs
 */
export class CollaborationService {
  private app: App;
  private authService: AuthService;
  private eventBus: EventBus;
  private yjsProvider: YjsProvider;
  
  // Collaboration state
  private enabled: boolean = false;
  private activeFiles: Map<string, Y.Doc> = new Map();
  private awarenessMap: Map<string, Awareness> = new Map();
  
  // User info
  private userId: string | null = null;
  private userName: string | null = null;
  private userColor: string = '#000000';
  
  // Collaborators tracking
  private collaborators: Map<string, CollaboratorInfo> = new Map();
  
  // Debug mode
  private debugMode: boolean = false;

  constructor(
    app: App,
    authService: AuthService,
    eventBus: EventBus,
    yjsProvider: YjsProvider,
    debugMode: boolean = false
  ) {
    this.app = app;
    this.authService = authService;
    this.eventBus = eventBus;
    this.yjsProvider = yjsProvider;
    this.debugMode = debugMode;
    
    // Generate user color
    this.userColor = this.generateUserColor();
  }

  /**
   * Initialize collaboration service
   */
  async initialize(userId: string, userName: string): Promise<void> {
    this.userId = userId;
    this.userName = userName;
    
    this.log(`Initialized collaboration for user ${userName} (${userId})`);
  }

  /**
   * Enable collaboration
   */
  async enable(): Promise<void> {
    if (this.enabled) {
      return;
    }

    this.enabled = true;
    this.log('Collaboration enabled');
    
    // Emit event
    this.eventBus.emit(EVENTS.COLLABORATOR_JOINED, {
      userId: this.userId,
      userName: this.userName
    });
  }

  /**
   * Disable collaboration
   */
  async disable(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    // Close all active files
    const filePaths = Array.from(this.activeFiles.keys());
    for (const filePath of filePaths) {
      await this.disableCollaboration(filePath);
    }

    this.enabled = false;
    this.log('Collaboration disabled');
    
    // Emit event
    this.eventBus.emit(EVENTS.COLLABORATOR_LEFT, {
      userId: this.userId
    });
  }

  /**
   * Check if collaboration is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Enable collaboration for a specific file
   */
  async enableCollaboration(filePath: string): Promise<void> {
    if (!this.enabled) {
      throw new Error('Collaboration service not enabled');
    }

    if (this.activeFiles.has(filePath)) {
      this.log(`Collaboration already enabled for ${filePath}`);
      return;
    }

    this.log(`Enabling collaboration for ${filePath}`);

    try {
      // Get or create Yjs document
      const doc = await this.yjsProvider.getDocument(filePath);
      
      // Store active file
      this.activeFiles.set(filePath, doc);

      // Create awareness instance
      const awareness = new Awareness(doc);
      this.awarenessMap.set(filePath, awareness);

      // Setup awareness handlers
      this.setupAwarenessHandlers(awareness, filePath);

      // Set local awareness state
      this.updateLocalAwareness(filePath);

      this.log(`Collaboration enabled for ${filePath}`);
      
      // Emit event
      this.eventBus.emit(EVENTS.FILE_OPENED, {
        userId: this.userId,
        filePath
      });
      
    } catch (error) {
      this.log(`Failed to enable collaboration: ${parseErrorMessage(error)}`);
      throw error;
    }
  }

  /**
   * Disable collaboration for a specific file
   */
  async disableCollaboration(filePath: string): Promise<void> {
    if (!this.activeFiles.has(filePath)) {
      return;
    }

    this.log(`Disabling collaboration for ${filePath}`);

    // Get awareness
    const awareness = this.awarenessMap.get(filePath);
    if (awareness) {
      // Clear local awareness state
      awareness.setLocalState(null);
      awareness.destroy();
      this.awarenessMap.delete(filePath);
    }

    // Remove from active files
    this.activeFiles.delete(filePath);

    // Close Yjs document
    await this.yjsProvider.closeDocument(filePath);

    this.log(`Collaboration disabled for ${filePath}`);
    
    // Emit event
    this.eventBus.emit(EVENTS.FILE_CLOSED, {
      userId: this.userId,
      filePath
    });
  }

  /**
   * Check if collaboration is active for a file
   */
  isCollaborationActive(filePath: string): boolean {
    return this.activeFiles.has(filePath);
  }

  /**
   * Get Yjs document for a file
   */
  getYjsDoc(filePath: string): Y.Doc | null {
    return this.activeFiles.get(filePath) || null;
  }

  /**
   * Sync Yjs document manually
   */
  async syncYjsDoc(filePath: string): Promise<void> {
    if (!this.activeFiles.has(filePath)) {
      throw new Error(`No active collaboration for ${filePath}`);
    }

    await this.yjsProvider.syncDocument(filePath);
  }

  /**
   * Update awareness state (cursor, selection)
   */
  updateAwareness(filePath: string, state: Partial<AwarenessState>): void {
    const awareness = this.awarenessMap.get(filePath);
    if (!awareness) {
      return;
    }

    // Get current state
    const currentState = awareness.getLocalState() || {};

    // Merge with new state
    const newState = {
      ...currentState,
      ...state,
      user: {
        id: this.userId!,
        name: this.userName!,
        color: this.userColor,
        ...state.user
      }
    };

    // Update awareness
    awareness.setLocalState(newState);

    this.log(`Updated awareness for ${filePath}`, newState);
  }

  /**
   * Get awareness states for a file
   */
  getAwarenessStates(filePath: string): Map<number, AwarenessState> {
    const awareness = this.awarenessMap.get(filePath);
    if (!awareness) {
      return new Map();
    }

    return awareness.getStates() as Map<number, AwarenessState>;
  }

  /**
   * Get collaborators for a file
   */
  getFileCollaborators(filePath: string): CollaboratorInfo[] {
    const awareness = this.awarenessMap.get(filePath);
    if (!awareness) {
      return [];
    }

    const collaborators: CollaboratorInfo[] = [];
    const states = awareness.getStates();

    states.forEach((state: AwarenessState, clientId: number) => {
      // Skip local user
      if (clientId === awareness.clientID) {
        return;
      }

      if (state.user) {
        collaborators.push({
          userId: state.user.id,
          userName: state.user.name,
          userAvatar: state.user.avatar,
          color: state.user.color,
          currentFile: filePath,
          status: state.isTyping ? 'active' : 'away',
          lastSeen: new Date()
        });
      }
    });

    return collaborators;
  }

  /**
   * Get all active collaborators
   */
  getAllCollaborators(): CollaboratorInfo[] {
    return Array.from(this.collaborators.values());
  }

  /**
   * Subscribe to collaborator joined events
   */
  onCollaboratorJoined(callback: (user: CollaboratorInfo) => void): () => void {
    return this.eventBus.on(EVENTS.COLLABORATOR_JOINED, callback);
  }

  /**
   * Subscribe to collaborator left events
   */
  onCollaboratorLeft(callback: (userId: string) => void): () => void {
    return this.eventBus.on(EVENTS.COLLABORATOR_LEFT, callback);
  }

  /**
   * Subscribe to remote change events
   */
  onRemoteChange(callback: (filePath: string, changes: Y.YEvent<Y.Text>[]) => void): () => void {
    return this.eventBus.on(EVENTS.REMOTE_CHANGE, callback);
  }

  /**
   * Get collaboration statistics
   */
  getStatistics(): {
    enabled: boolean;
    activeFiles: number;
    totalCollaborators: number;
  } {
    return {
      enabled: this.enabled,
      activeFiles: this.activeFiles.size,
      totalCollaborators: this.collaborators.size
    };
  }

  /**
   * Cleanup and destroy
   */
  async destroy(): Promise<void> {
    this.log('Destroying CollaborationService');
    await this.disable();
  }

  // Private methods

  /**
   * Setup awareness event handlers
   */
  private setupAwarenessHandlers(awareness: Awareness, filePath: string): void {
    // Handle awareness changes
    awareness.on('change', (changes: { added: number[]; updated: number[]; removed: number[] }) => {
      this.log(`Awareness changed for ${filePath}`, changes);

      // Process added clients
      changes.added.forEach((clientId: number) => {
        const state = awareness.getStates().get(clientId);
        if (state && state.user) {
          this.handleCollaboratorJoined(state.user, filePath);
        }
      });

      // Process updated clients
      changes.updated.forEach((clientId: number) => {
        const state = awareness.getStates().get(clientId);
        if (state && state.user) {
          this.handleAwarenessUpdate(clientId, state as AwarenessState, filePath);
        }
      });

      // Process removed clients
      changes.removed.forEach((clientId: number) => {
        this.handleCollaboratorLeft(clientId, filePath);
      });

      // Emit event
      this.eventBus.emit(EVENTS.YJS_AWARENESS_UPDATED, {
        filePath,
        changes
      });
    });
  }

  /**
   * Handle collaborator joined
   */
  private handleCollaboratorJoined(user: AwarenessState['user'], filePath: string): void {
    // Skip local user
    if (user.id === this.userId) {
      return;
    }

    this.log(`Collaborator joined: ${user.name} on ${filePath}`);

    const collaborator: CollaboratorInfo = {
      userId: user.id,
      userName: user.name,
      userAvatar: user.avatar,
      color: user.color,
      currentFile: filePath,
      status: 'active',
      lastSeen: new Date()
    };

    this.collaborators.set(user.id, collaborator);

    // Emit event
    this.eventBus.emit(EVENTS.COLLABORATOR_JOINED, collaborator);
  }

  /**
   * Handle awareness update (cursor, selection, typing)
   */
  private handleAwarenessUpdate(clientId: number, state: AwarenessState, filePath: string): void {
    // Skip local user
    if (state.user?.id === this.userId) {
      return;
    }

    // Update collaborator info
    if (state.user && this.collaborators.has(state.user.id)) {
      const collaborator = this.collaborators.get(state.user.id)!;
      collaborator.status = state.isTyping ? 'active' : 'away';
      collaborator.lastSeen = new Date();
    }

    // Emit cursor update
    if (state.cursor) {
      this.eventBus.emit(EVENTS.YJS_REMOTE_CURSOR, {
        filePath,
        userId: state.user?.id,
        cursor: state.cursor
      });
    }

    // Emit selection update
    if (state.selection) {
      this.eventBus.emit(EVENTS.YJS_REMOTE_SELECTION, {
        filePath,
        userId: state.user?.id,
        selection: state.selection
      });
    }
  }

  /**
   * Handle collaborator left
   */
  private handleCollaboratorLeft(clientId: number, filePath: string): void {
    // Find and remove collaborator
    for (const [userId, collaborator] of this.collaborators.entries()) {
      if (collaborator.currentFile === filePath) {
        this.log(`Collaborator left: ${collaborator.userName} from ${filePath}`);
        this.collaborators.delete(userId);
        
        // Emit event
        this.eventBus.emit(EVENTS.COLLABORATOR_LEFT, userId);
        break;
      }
    }
  }

  /**
   * Update local awareness state
   */
  private updateLocalAwareness(filePath: string): void {
    const awareness = this.awarenessMap.get(filePath);
    if (!awareness) {
      return;
    }

    awareness.setLocalState({
      user: {
        id: this.userId!,
        name: this.userName!,
        color: this.userColor
      },
      cursor: null,
      selection: null,
      isTyping: false
    });
  }

  /**
   * Generate random user color
   */
  private generateUserColor(): string {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
      '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2',
      '#F8B739', '#52B788', '#E76F51', '#2A9D8F'
    ];
    
    return colors[Math.floor(Math.random() * colors.length)];
  }

  /**
   * Log message (if debug mode enabled)
   */
  private log(message: string, data?: unknown): void {
    if (this.debugMode) {
      if (data !== undefined) {
        console.debug(`[CollaborationService] ${message}`, data);
      } else {
        console.debug(`[CollaborationService] ${message}`);
      }
    }
  }
}
