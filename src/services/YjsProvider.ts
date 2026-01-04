import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { EventBus, EVENTS } from '../core/EventBus';
import { StorageManager } from '../core/StorageManager';
import { AuthService } from './AuthService';
import { parseErrorMessage } from '../utils/helpers';

export interface YjsDocumentInfo {
  doc: Y.Doc;
  provider: WebsocketProvider;
  filePath: string;
  isConnected: boolean;
  lastSynced: Date;
}

/**
 * Yjs Provider Service
 * Manages Yjs documents and WebSocket providers for real-time collaboration
 */
export class YjsProvider {
  private authService: AuthService;
  private eventBus: EventBus;
  private storageManager: StorageManager;
  private wsBaseURL: string;
  private vaultId: string | null = null;

  // Document management
  private documents: Map<string, YjsDocumentInfo> = new Map();

  // Persistence
  private persistenceEnabled: boolean = true;
  private persistenceKey: string = 'yjs-documents';

  // Debug mode
  private debugMode: boolean = false;

  constructor(
    authService: AuthService,
    eventBus: EventBus,
    storageManager: StorageManager,
    wsBaseURL: string,
    debugMode: boolean = false
  ) {
    this.authService = authService;
    this.eventBus = eventBus;
    this.storageManager = storageManager;
    this.wsBaseURL = wsBaseURL;
    this.debugMode = debugMode;
  }

  /**
   * Initialize provider with vault ID
   */
  async initialize(vaultId: string): Promise<void> {
    this.vaultId = vaultId;
    this.log(`Initialized with vault ${vaultId}`);
    
    // Load persisted documents
    if (this.persistenceEnabled) {
      await this.loadPersistedDocuments();
    }
  }

  /**
   * Get or create Yjs document for a file
   */
  async getDocument(filePath: string): Promise<Y.Doc> {
    // Check if document already exists
    const existing = this.documents.get(filePath);
    if (existing) {
      this.log(`Returning existing document for ${filePath}`);
      return existing.doc;
    }

    // Create new document
    this.log(`Creating new document for ${filePath}`);
    const doc = await this.createDocument(filePath);
    return doc;
  }

  /**
   * Create a new Yjs document with WebSocket provider
   */
  private async createDocument(filePath: string): Promise<Y.Doc> {
    if (!this.vaultId) {
      throw new Error('YjsProvider not initialized with vault ID');
    }

    // Create Yjs document
    const doc = new Y.Doc();
    
    // Get API key for authentication
    const apiKey = await this.authService.getApiKey();
    if (!apiKey) {
      throw new Error('No API key available for Yjs connection');
    }

    // Create WebSocket provider
    // Document name format: vault_id/file_path
    const documentName = `${this.vaultId}/${filePath}`;
    
    // Convert HTTP(S) URL to WS(S)
    const wsUrl = this.wsBaseURL.replace(/^http/, 'ws');
    
    const provider = new WebsocketProvider(
      wsUrl,
      documentName,
      doc,
      {
        params: {
          token: apiKey
        },
        connect: true,
        resyncInterval: 5000, // Resync every 5 seconds
        maxBackoffTime: 30000 // Max 30 seconds backoff
      }
    );

    // Setup provider event handlers
    this.setupProviderHandlers(provider, filePath);

    // Store document info
    const docInfo: YjsDocumentInfo = {
      doc,
      provider,
      filePath,
      isConnected: false,
      lastSynced: new Date()
    };
    
    this.documents.set(filePath, docInfo);

    // Load persisted state if available
    if (this.persistenceEnabled) {
      await this.loadDocumentState(filePath, doc);
    }

    this.log(`Created document for ${filePath}`);
    
    return doc;
  }

  /**
   * Setup WebSocket provider event handlers
   */
  private setupProviderHandlers(provider: WebsocketProvider, filePath: string): void {
    provider.on('status', (event: { status: string }) => {
      this.log(`Provider status for ${filePath}: ${event.status}`);
      
      const docInfo = this.documents.get(filePath);
      if (docInfo) {
        docInfo.isConnected = event.status === 'connected';
        docInfo.lastSynced = new Date();
      }

      // Emit event
      this.eventBus.emit(EVENTS.YJS_PROVIDER_STATUS, {
        filePath,
        status: event.status
      });
    });

    provider.on('sync', (isSynced: boolean) => {
      this.log(`Provider sync for ${filePath}: ${isSynced}`);
      
      const docInfo = this.documents.get(filePath);
      if (docInfo) {
        docInfo.lastSynced = new Date();
      }

      // Persist document state
      if (this.persistenceEnabled && isSynced) {
        void this.persistDocumentState(filePath);
      }

      // Emit event
      this.eventBus.emit(EVENTS.YJS_DOCUMENT_SYNCED, {
        filePath,
        isSynced
      });
    });

    provider.on('connection-close', (event: CloseEvent) => {
      this.log(`Provider connection closed for ${filePath}: ${event.code} - ${event.reason}`);
      
      const docInfo = this.documents.get(filePath);
      if (docInfo) {
        docInfo.isConnected = false;
      }

      // Emit event
      this.eventBus.emit(EVENTS.YJS_PROVIDER_DISCONNECTED, {
        filePath,
        code: event.code,
        reason: event.reason
      });
    });

    provider.on('connection-error', (event: Event) => {
      this.log(`Provider connection error for ${filePath}`, event);
      
      // Emit event
      this.eventBus.emit(EVENTS.YJS_PROVIDER_ERROR, {
        filePath,
        error: 'Connection error'
      });
    });
  }

  /**
   * Close document and disconnect provider
   */
  async closeDocument(filePath: string): Promise<void> {
    const docInfo = this.documents.get(filePath);
    if (!docInfo) {
      return;
    }

    this.log(`Closing document for ${filePath}`);

    // Persist final state
    if (this.persistenceEnabled) {
      await this.persistDocumentState(filePath);
    }

    // Disconnect provider
    docInfo.provider.disconnect();
    docInfo.provider.destroy();

    // Destroy document
    docInfo.doc.destroy();

    // Remove from map
    this.documents.delete(filePath);

    this.log(`Closed document for ${filePath}`);
  }

  /**
   * Check if document exists
   */
  hasDocument(filePath: string): boolean {
    return this.documents.has(filePath);
  }

  /**
   * Get document info
   */
  getDocumentInfo(filePath: string): YjsDocumentInfo | null {
    return this.documents.get(filePath) || null;
  }

  /**
   * Get all active documents
   */
  getActiveDocuments(): string[] {
    return Array.from(this.documents.keys());
  }

  /**
   * Check if document is connected
   */
  isDocumentConnected(filePath: string): boolean {
    const docInfo = this.documents.get(filePath);
    return docInfo?.isConnected || false;
  }

  /**
   * Sync document manually
   */
  syncDocument(filePath: string): void {
    const docInfo = this.documents.get(filePath);
    if (!docInfo) {
      throw new Error(`Document not found: ${filePath}`);
    }

    this.log(`Manually syncing document ${filePath}`);

    // Force sync by reconnecting provider
    docInfo.provider.disconnect();
    docInfo.provider.connect();
  }

  /**
   * Close all documents
   */
  async closeAllDocuments(): Promise<void> {
    this.log('Closing all documents');
    
    const filePaths = Array.from(this.documents.keys());
    
    for (const filePath of filePaths) {
      await this.closeDocument(filePath);
    }
    
    this.log('All documents closed');
  }

  /**
   * Enable persistence
   */
  enablePersistence(): void {
    this.persistenceEnabled = true;
    this.log('Persistence enabled');
  }

  /**
   * Disable persistence
   */
  disablePersistence(): void {
    this.persistenceEnabled = false;
    this.log('Persistence disabled');
  }

  /**
   * Persist document state to storage
   */
  private async persistDocumentState(filePath: string): Promise<void> {
    const docInfo = this.documents.get(filePath);
    if (!docInfo) {
      return;
    }

    try {
      // Encode document state
      const state = Y.encodeStateAsUpdate(docInfo.doc);

      // Store using StorageManager's setYjsDocument method
      this.storageManager.setYjsDocument(filePath, state);
      await this.storageManager.save();

      this.log(`Persisted document state for ${filePath}`);

    } catch (error) {
      this.log(`Failed to persist document state: ${parseErrorMessage(error)}`);
    }
  }

  /**
   * Load document state from storage
   */
  private loadDocumentState(filePath: string, doc: Y.Doc): void {
    try {
      const state = this.storageManager.getYjsDocument(filePath);

      if (!state) {
        this.log(`No persisted state found for ${filePath}`);
        return;
      }

      // Apply state
      Y.applyUpdate(doc, state);

      this.log(`Loaded persisted state for ${filePath}`);

    } catch (error) {
      this.log(`Failed to load document state: ${parseErrorMessage(error)}`);
    }
  }

  /**
   * Load all persisted documents
   */
  private loadPersistedDocuments(): void {
    if (!this.vaultId) {
      return;
    }

    // Note: Documents are loaded on-demand when opened
    this.log('Yjs persistence initialized');
  }

  /**
   * Clear persisted document state
   */
  async clearPersistedState(filePath?: string): Promise<void> {
    if (!this.vaultId) {
      return;
    }

    try {
      if (filePath) {
        // Clear specific document
        this.storageManager.deleteYjsDocument(filePath);
        await this.storageManager.save();
        this.log(`Cleared persisted state for ${filePath}`);
      } else {
        // Clear all documents - handled by storage manager clear
        this.log('Clear all persisted states requested');
      }

    } catch (error) {
      this.log(`Failed to clear persisted state: ${parseErrorMessage(error)}`);
    }
  }

  /**
   * Get document statistics
   */
  getStatistics(): {
    activeDocuments: number;
    connectedDocuments: number;
    totalSize: number;
  } {
    let connectedCount = 0;
    let totalSize = 0;

    for (const docInfo of this.documents.values()) {
      if (docInfo.isConnected) {
        connectedCount++;
      }
      
      // Calculate document size
      const state = Y.encodeStateAsUpdate(docInfo.doc);
      totalSize += state.length;
    }

    return {
      activeDocuments: this.documents.size,
      connectedDocuments: connectedCount,
      totalSize
    };
  }

  /**
   * Cleanup and destroy
   */
  async destroy(): Promise<void> {
    this.log('Destroying YjsProvider');
    await this.closeAllDocuments();
  }

  // Utility methods

  /**
   * Convert Uint8Array to Base64
   */
  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert Base64 to Uint8Array
   */
  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Log message (if debug mode enabled)
   */
  private log(message: string, data?: unknown): void {
    if (this.debugMode) {
      if (data !== undefined) {
        console.debug(`[YjsProvider] ${message}`, data);
      } else {
        console.debug(`[YjsProvider] ${message}`);
      }
    }
  }
}
