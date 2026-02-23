/**
 * E2E Yjs Provider for Obsidian Plugin
 *
 * Custom WebSocket provider for E2E-encrypted vaults using Node.js crypto.
 * Encrypts outgoing Yjs updates and decrypts incoming ones using the vault's VEK.
 *
 * Custom message types (matching backend):
 *   0-2: Standard Yjs sync (encrypted payload)
 *   10: Encrypted snapshot
 *   12: Snapshot request
 */

import * as Y from 'yjs';
import * as crypto from 'crypto';

const E2E_MSG_ENCRYPTED_SNAPSHOT = 10;
const E2E_MSG_SNAPSHOT_REQUEST = 12;
const SNAPSHOT_INTERVAL = 30000; // 30 seconds
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface E2EYjsProviderOptions {
  wsUrl: string;
  roomName: string;
  doc: Y.Doc;
  vek: Buffer;
  token: string;
  maxReconnectAttempts?: number;
}

export class E2EYjsProvider {
  doc: Y.Doc;
  wsconnected: boolean = false;
  synced: boolean = false;

  private ws: WebSocket | null = null;
  private wsUrl: string;
  private roomName: string;
  private vek: Buffer;
  private token: string;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number;
  private destroyed: boolean = false;
  private listeners: Map<string, Set<Function>> = new Map();

  constructor(options: E2EYjsProviderOptions) {
    this.wsUrl = options.wsUrl;
    this.roomName = options.roomName;
    this.doc = options.doc;
    this.vek = options.vek;
    this.token = options.token;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;

    // Listen for local updates
    this.doc.on('update', this._onDocUpdate);
    this.connect();
  }

  private _onDocUpdate = (update: Uint8Array, origin: any) => {
    if (origin === this) return;
    this.sendEncryptedUpdate(update);
    this.scheduleSnapshot();
  };

  connect(): void {
    if (this.destroyed) return;

    const url = `${this.wsUrl}/${this.roomName}?token=${this.token}`;
    this.ws = new WebSocket(url);
    (this.ws as any).binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.wsconnected = true;
      this.reconnectAttempts = 0;
      this.emit('status', { status: 'connected' });

      // Request stored encrypted snapshot
      const req = new Uint8Array(1);
      req[0] = E2E_MSG_SNAPSHOT_REQUEST;
      this.ws!.send(req);
    };

    this.ws.onmessage = (event: MessageEvent) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data.length < 1) return;
      this.handleMessage(data);
    };

    this.ws.onclose = () => {
      this.wsconnected = false;
      this.synced = false;
      this.emit('status', { status: 'disconnected' });

      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose fires after onerror
    };
  }

  private handleMessage(data: Uint8Array): void {
    const messageType = data[0];
    const payload = data.slice(1);

    switch (messageType) {
      case 0: // Sync step 1
      case 1: // Sync step 2 / Awareness
      case 2: { // Update
        try {
          const decrypted = this.decryptBytes(payload);
          Y.applyUpdate(this.doc, decrypted, this);
        } catch (err) {
          console.error('E2E Plugin: Failed to decrypt incoming update', err);
        }
        break;
      }

      case E2E_MSG_ENCRYPTED_SNAPSHOT: {
        try {
          const decryptedSnapshot = this.decryptBytes(payload);
          Y.applyUpdate(this.doc, decryptedSnapshot, this);
          this.synced = true;
          this.emit('sync', true);
        } catch (err) {
          console.error('E2E Plugin: Failed to decrypt snapshot', err);
          this.synced = true;
          this.emit('sync', true);
        }
        break;
      }

      default:
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts || this.destroyed) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed) {
        this.emit('status', { status: 'connecting' });
        this.connect();
      }
    }, delay);
  }

  private sendEncryptedUpdate(update: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      const encrypted = this.encryptBytes(Buffer.from(update));
      const message = new Uint8Array(encrypted.length + 1);
      message[0] = 2; // Update type
      message.set(encrypted, 1);
      this.ws.send(message);
    } catch (err) {
      console.error('E2E Plugin: Failed to encrypt outgoing update', err);
    }
  }

  private sendSnapshot(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      const state = Y.encodeStateAsUpdate(this.doc);
      const encrypted = this.encryptBytes(Buffer.from(state));
      const message = new Uint8Array(encrypted.length + 1);
      message[0] = E2E_MSG_ENCRYPTED_SNAPSHOT;
      message.set(encrypted, 1);
      this.ws.send(message);
    } catch (err) {
      console.error('E2E Plugin: Failed to send encrypted snapshot', err);
    }
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
    }
    this.snapshotTimer = setTimeout(() => {
      this.sendSnapshot();
    }, SNAPSHOT_INTERVAL);
  }

  // ────────────────────── AES-256-GCM Encrypt/Decrypt ──────────────────────

  private encryptBytes(data: Buffer): Uint8Array {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.vek, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Format: [12 bytes IV][encrypted data][16 bytes auth tag]
    return new Uint8Array(Buffer.concat([iv, encrypted, authTag]));
  }

  private decryptBytes(data: Uint8Array): Uint8Array {
    if (data.length < IV_BYTES + AUTH_TAG_BYTES + 1) {
      throw new Error('Invalid encrypted data: too short');
    }
    const buf = Buffer.from(data);
    const iv = buf.subarray(0, IV_BYTES);
    const authTag = buf.subarray(buf.length - AUTH_TAG_BYTES);
    const ciphertext = buf.subarray(IV_BYTES, buf.length - AUTH_TAG_BYTES);

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.vek, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return new Uint8Array(decrypted);
  }

  // ────────────────────── Event Emitter ──────────────────────

  on(event: string, handler: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: Function): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach((handler) => {
      try {
        handler(...args);
      } catch (err) {
        console.error(`E2E YjsProvider event handler error (${event}):`, err);
      }
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.doc.off('update', this._onDocUpdate);

    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.disconnect();
    this.listeners.clear();
  }
}
