import { EventBus, EVENTS } from './EventBus';
import { AuthService } from '../services/AuthService';
import { WS_EVENTS } from '../utils/constants';
import { parseErrorMessage } from '../utils/helpers';

export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

export interface WebSocketMessage {
  event: string;
  data?: any;
  timestamp?: number;
}

export interface SubscriptionInfo {
  vaultId: string;
  deviceId: string;
}

/**
 * WebSocket Manager
 * Manages WebSocket connections for real-time features
 */
export class WebSocketManager {
  private authService: AuthService;
  private eventBus: EventBus;
  private wsBaseURL: string;
  private ws: WebSocket | null = null;
  private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  private subscription: SubscriptionInfo | null = null;
  
  // Reconnection
  private autoReconnect: boolean = true;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private baseReconnectDelay: number = 1000; // 1 second
  private maxReconnectDelay: number = 30000; // 30 seconds
  
  // Heartbeat - Optimized for faster connection health detection
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs: number = 15000; // 15 seconds (reduced from 30)
  private lastHeartbeatResponse: number = Date.now();
  private heartbeatTimeout: number = 15000; // 15 seconds (increased from 10 for reliability)
  
  // Message queue for offline messages
  private messageQueue: WebSocketMessage[] = [];
  private maxQueueSize: number = 100;
  
  // Debug mode
  private debugMode: boolean = false;

  constructor(
    authService: AuthService,
    eventBus: EventBus,
    wsBaseURL: string,
    debugMode: boolean = false
  ) {
    this.authService = authService;
    this.eventBus = eventBus;
    this.wsBaseURL = wsBaseURL;
    this.debugMode = debugMode;
  }

  /**
   * Connect to WebSocket server
   */
  async connect(apiKey: string, vaultId?: string): Promise<void> {
    if (this.connectionState === ConnectionState.CONNECTED) {
      this.log('Already connected');
      return;
    }

    if (this.connectionState === ConnectionState.CONNECTING) {
      this.log('Connection already in progress');
      return;
    }

    this.setConnectionState(ConnectionState.CONNECTING);

    try {
      // Construct WebSocket URL with authentication
      const wsUrl = this.buildWebSocketUrl(apiKey);
      
      this.log(`Connecting to ${wsUrl}`);
      
      // Create WebSocket connection
      this.ws = new WebSocket(wsUrl);
      
      // Set up event handlers
      this.setupWebSocketHandlers();
      
      // Wait for connection to be established
      await this.waitForConnection();
      
      this.log('WebSocket connected');
      
      // Reset reconnection attempts on successful connection
      this.reconnectAttempts = 0;
      
      // Start heartbeat
      this.startHeartbeat();
      
      // If we have a subscription, resubscribe
      if (vaultId) {
        await this.subscribe(vaultId, this.getDeviceId());
      }
      
      // Process queued messages
      this.processMessageQueue();
      
    } catch (error) {
      this.log(`Connection failed: ${parseErrorMessage(error)}`);
      this.setConnectionState(ConnectionState.ERROR);
      this.eventBus.emit(EVENTS.CONNECTION_ERROR, error);
      
      // Attempt reconnection if enabled
      if (this.autoReconnect) {
        this.scheduleReconnect();
      }
      
      throw error;
    }
  }

  /**
   * Disconnect from WebSocket server
   */
  async disconnect(): Promise<void> {
    this.log('Disconnecting...');
    
    // Disable auto-reconnect
    this.autoReconnect = false;
    
    // Clear reconnection timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    // Stop heartbeat
    this.stopHeartbeat();
    
    // Close WebSocket
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    
    // Clear subscription
    this.subscription = null;
    
    // Update state
    this.setConnectionState(ConnectionState.DISCONNECTED);
    
    this.log('Disconnected');
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return (
      this.connectionState === ConnectionState.CONNECTED &&
      this.ws !== null &&
      this.ws.readyState === WebSocket.OPEN
    );
  }

  /**
   * Get connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Subscribe to vault events
   */
  async subscribe(vaultId: string, deviceId: string): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('Not connected to WebSocket server');
    }

    this.log(`Subscribing to vault ${vaultId} with device ${deviceId}`);
    
    this.subscription = { vaultId, deviceId };
    
    // Send subscription message
    this.send(WS_EVENTS.SUBSCRIBE, {
      vault_id: vaultId,
      device_id: deviceId
    });
    
    // Wait for subscription confirmation
    await this.waitForEvent(WS_EVENTS.SUBSCRIBED, 5000);
    
    this.log(`Subscribed to vault ${vaultId}`);
  }

  /**
   * Unsubscribe from vault events
   */
  async unsubscribe(vaultId: string): Promise<void> {
    if (!this.isConnected()) {
      return;
    }

    this.log(`Unsubscribing from vault ${vaultId}`);
    
    // Send unsubscribe message
    this.send(WS_EVENTS.UNSUBSCRIBE, {
      vault_id: vaultId
    });
    
    // Clear subscription
    this.subscription = null;
    
    this.log(`Unsubscribed from vault ${vaultId}`);
  }

  /**
   * Send message to server
   */
  send(event: string, data?: any): void {
    const message: WebSocketMessage = {
      event,
      data,
      timestamp: Date.now()
    };

    if (!this.isConnected()) {
      this.log(`Not connected, queueing message: ${event}`);
      this.queueMessage(message);
      return;
    }

    try {
      const payload = JSON.stringify(message);
      this.ws!.send(payload);
      this.log(`Sent message: ${event}`, data);
    } catch (error) {
      this.log(`Failed to send message: ${parseErrorMessage(error)}`);
      this.queueMessage(message);
    }
  }

  /**
   * Subscribe to WebSocket events
   */
  on(event: string, handler: (data: any) => void): () => void {
    return this.eventBus.on(`ws:${event}`, handler);
  }

  /**
   * Unsubscribe from WebSocket events
   */
  off(event: string, handler: (data: any) => void): void {
    this.eventBus.off(`ws:${event}`, handler);
  }

  /**
   * Enable auto-reconnect
   */
  enableAutoReconnect(): void {
    this.autoReconnect = true;
    this.log('Auto-reconnect enabled');
  }

  /**
   * Disable auto-reconnect
   */
  disableAutoReconnect(): void {
    this.autoReconnect = false;
    this.log('Auto-reconnect disabled');
  }

  /**
   * Subscribe to connection events
   */
  onConnected(callback: () => void): () => void {
    return this.eventBus.on(EVENTS.CONNECTION_CHANGED, (state: ConnectionState) => {
      if (state === ConnectionState.CONNECTED) {
        callback();
      }
    });
  }

  /**
   * Subscribe to disconnection events
   */
  onDisconnected(callback: (reason: string) => void): () => void {
    return this.eventBus.on(EVENTS.CONNECTION_CHANGED, (state: ConnectionState, reason?: string) => {
      if (state === ConnectionState.DISCONNECTED) {
        callback(reason || 'Unknown reason');
      }
    });
  }

  /**
   * Subscribe to error events
   */
  onError(callback: (error: Error) => void): () => void {
    return this.eventBus.on(EVENTS.CONNECTION_ERROR, callback);
  }

  /**
   * Subscribe to reconnection events
   */
  onReconnecting(callback: (attempt: number) => void): () => void {
    return this.eventBus.on(EVENTS.CONNECTION_CHANGED, (state: ConnectionState, attempt?: number) => {
      if (state === ConnectionState.RECONNECTING) {
        callback(attempt || 0);
      }
    });
  }

  /**
   * Get message queue size
   */
  getQueueSize(): number {
    return this.messageQueue.length;
  }

  /**
   * Clear message queue
   */
  clearQueue(): void {
    this.messageQueue = [];
    this.eventBus.emit(EVENTS.QUEUE_UPDATED, 0);
  }

  /**
   * Get reconnection attempts
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * Reset reconnection attempts
   */
  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.disconnect();
    this.messageQueue = [];
  }

  // Private methods

  /**
   * Build WebSocket URL with authentication
   */
  private buildWebSocketUrl(apiKey: string): string {
    // Convert HTTP(S) URL to WS(S)
    const wsUrl = this.wsBaseURL.replace(/^http/, 'ws');
    
    // Add authentication as query parameter
    const url = new URL(wsUrl);
    url.searchParams.set('token', apiKey);
    
    return url.toString();
  }

  /**
   * Get device ID
   */
  private getDeviceId(): string {
    // Generate or retrieve device ID
    // This should be stored in plugin settings
    return `device_${Date.now()}`;
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupWebSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.onopen = () => {
      this.log('WebSocket opened');
      this.setConnectionState(ConnectionState.CONNECTED);
    };

    this.ws.onclose = (event) => {
      this.log(`WebSocket closed: ${event.code} - ${event.reason}`);
      this.handleDisconnection(event.reason || 'Connection closed');
    };

    this.ws.onerror = (event) => {
      this.log('WebSocket error', event);
      this.eventBus.emit(EVENTS.CONNECTION_ERROR, new Error('WebSocket error'));
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: string): void {
    try {
      const message: WebSocketMessage = JSON.parse(data);
      this.log(`Received message: ${message.event}`, message.data);
      
      // Handle special events
      if (message.event === WS_EVENTS.PONG) {
        this.lastHeartbeatResponse = Date.now();
        return;
      }
      
      // Emit event to subscribers
      this.eventBus.emit(`ws:${message.event}`, message.data);
      
    } catch (error) {
      this.log(`Failed to parse message: ${parseErrorMessage(error)}`);
    }
  }

  /**
   * Handle disconnection
   */
  private handleDisconnection(reason: string): void {
    this.stopHeartbeat();
    
    // Only change state if not already disconnected
    if (this.connectionState !== ConnectionState.DISCONNECTED) {
      this.setConnectionState(ConnectionState.DISCONNECTED, reason);
    }
    
    // Attempt reconnection if enabled
    if (this.autoReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log(`Max reconnection attempts (${this.maxReconnectAttempts}) reached`);
      this.eventBus.emit(EVENTS.CONNECTION_ERROR, new Error('Max reconnection attempts reached'));
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      return; // Already scheduled
    }

    this.reconnectAttempts++;
    
    // Calculate delay with exponential backoff
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );
    
    this.log(`Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    this.setConnectionState(ConnectionState.RECONNECTING, this.reconnectAttempts);
    
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      
      try {
        const apiKey = await this.authService.getApiKey();
        if (!apiKey) {
          this.log('Cannot reconnect: No API key');
          this.autoReconnect = false;
          return;
        }
        
        const vaultId = this.subscription?.vaultId;
        await this.connect(apiKey, vaultId);
        
      } catch (error) {
        this.log(`Reconnection attempt ${this.reconnectAttempts} failed`);
        // Will schedule another attempt via handleDisconnection
      }
    }, delay);
  }

  /**
   * Start heartbeat mechanism
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    this.heartbeatInterval = setInterval(() => {
      // Check if last heartbeat response is too old
      const timeSinceLastResponse = Date.now() - this.lastHeartbeatResponse;
      
      if (timeSinceLastResponse > this.heartbeatTimeout + this.heartbeatIntervalMs) {
        this.log('Heartbeat timeout - connection may be dead');
        this.handleDisconnection('Heartbeat timeout');
        return;
      }
      
      // Send ping
      this.send(WS_EVENTS.PING);
      
    }, this.heartbeatIntervalMs);
    
    this.log('Heartbeat started');
  }

  /**
   * Stop heartbeat mechanism
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.log('Heartbeat stopped');
    }
  }

  /**
   * Queue message for later sending
   */
  private queueMessage(message: WebSocketMessage): void {
    if (this.messageQueue.length >= this.maxQueueSize) {
      this.log('Message queue full, dropping oldest message');
      this.messageQueue.shift();
    }
    
    this.messageQueue.push(message);
    this.eventBus.emit(EVENTS.QUEUE_UPDATED, this.messageQueue.length);
  }

  /**
   * Process queued messages
   */
  private processMessageQueue(): void {
    if (this.messageQueue.length === 0) {
      return;
    }

    this.log(`Processing ${this.messageQueue.length} queued messages`);
    
    const messages = [...this.messageQueue];
    this.messageQueue = [];
    
    for (const message of messages) {
      this.send(message.event, message.data);
    }
    
    this.eventBus.emit(EVENTS.QUEUE_UPDATED, 0);
  }

  /**
   * Wait for connection to be established
   */
  private waitForConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not initialized'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000); // 10 second timeout

      const checkConnection = () => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          clearTimeout(timeout);
          resolve();
        } else if (this.ws?.readyState === WebSocket.CLOSED || this.ws?.readyState === WebSocket.CLOSING) {
          clearTimeout(timeout);
          reject(new Error('Connection failed'));
        } else {
          setTimeout(checkConnection, 100);
        }
      };

      checkConnection();
    });
  }

  /**
   * Wait for specific event
   */
  private waitForEvent(event: string, timeout: number = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timeout waiting for event: ${event}`));
      }, timeout);

      const handler = (data: any) => {
        clearTimeout(timer);
        this.off(event, handler);
        resolve(data);
      };

      this.on(event, handler);
    });
  }

  /**
   * Set connection state and emit event
   */
  private setConnectionState(state: ConnectionState, data?: any): void {
    this.connectionState = state;
    this.eventBus.emit(EVENTS.CONNECTION_CHANGED, state, data);
    this.log(`Connection state: ${state}`);
  }

  /**
   * Log message (if debug mode enabled)
   */
  private log(message: string, data?: any): void {
    if (this.debugMode) {
      if (data !== undefined) {
        console.debug(`[WebSocketManager] ${message}`, data);
      } else {
        console.debug(`[WebSocketManager] ${message}`);
      }
    }
  }
}
