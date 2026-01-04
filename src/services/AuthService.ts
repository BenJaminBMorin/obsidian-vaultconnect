import { Plugin, requestUrl } from 'obsidian';
import { EventBus, EVENTS } from '../core/EventBus';

export interface AuthResult {
  apiKey: string;
  expiresAt: Date;
  scopes: string[];
}

export interface AuthState {
  isAuthenticated: boolean;
  apiKey: string | null;
  expiresAt: Date | null;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scopes: string[];
}

/**
 * Authentication Service
 * Handles API key authentication and token management
 */
export class AuthService {
  private plugin: Plugin;
  private eventBus: EventBus;
  private apiKey: string | null = null;
  private expiresAt: Date | null = null;
  private expirationCheckInterval: NodeJS.Timeout | null = null;

  constructor(plugin: Plugin, eventBus: EventBus) {
    this.plugin = plugin;
    this.eventBus = eventBus;
  }

  /**
   * Initialize the auth service
   */
  async initialize(): Promise<void> {
    // Load stored API key
    const settings = await this.plugin.loadData();
    if (settings?.apiKey && settings?.apiKeyExpires) {
      this.apiKey = settings.apiKey;
      this.expiresAt = new Date(settings.apiKeyExpires);
      
      // Check if token is still valid
      if (this.isTokenExpired()) {
        console.debug('Stored API key has expired');
        await this.clearApiKey();
      } else {
        console.debug('Loaded valid API key from storage');
        this.startExpirationCheck();
        this.eventBus.emit(EVENTS.AUTH_STATE_CHANGED, true);
      }
    }
  }

  /**
   * Store API key
   */
  async storeApiKey(apiKey: string, expiresAt: Date): Promise<void> {
    this.apiKey = apiKey;
    this.expiresAt = expiresAt;

    // Save to plugin data
    const settings = await this.plugin.loadData() || {};
    settings.apiKey = apiKey;
    settings.apiKeyExpires = expiresAt.toISOString();
    await this.plugin.saveData(settings);

    // Start expiration checking
    this.startExpirationCheck();

    // Emit auth state changed
    this.eventBus.emit(EVENTS.AUTH_STATE_CHANGED, true);

    console.debug('API key stored successfully');
  }

  /**
   * Get current API key
   */
  async getApiKey(): Promise<string | null> {
    if (!this.apiKey) {
      return null;
    }

    // Check if expired
    if (this.isTokenExpired()) {
      await this.clearApiKey();
      return null;
    }

    return this.apiKey;
  }

  /**
   * Clear API key (logout)
   */
  async clearApiKey(): Promise<void> {
    this.apiKey = null;
    this.expiresAt = null;

    // Clear from plugin data
    const settings = await this.plugin.loadData() || {};
    settings.apiKey = null;
    settings.apiKeyExpires = null;
    await this.plugin.saveData(settings);

    // Stop expiration checking
    this.stopExpirationCheck();

    // Emit auth state changed
    this.eventBus.emit(EVENTS.AUTH_STATE_CHANGED, false);

    console.debug('API key cleared');
  }

  /**
   * Check if authenticated
   */
  isAuthenticated(): boolean {
    return this.apiKey !== null && !this.isTokenExpired();
  }

  /**
   * Check if token is expired
   */
  isTokenExpired(): boolean {
    if (!this.expiresAt) {
      return true;
    }

    return new Date() >= this.expiresAt;
  }

  /**
   * Check if token is expiring soon (within 7 days)
   */
  isTokenExpiringSoon(): boolean {
    if (!this.expiresAt) {
      return false;
    }

    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    return this.expiresAt <= sevenDaysFromNow;
  }

  /**
   * Get days until expiration
   */
  getDaysUntilExpiration(): number | null {
    if (!this.expiresAt) {
      return null;
    }

    const now = new Date();
    const diffMs = this.expiresAt.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    return diffDays;
  }

  /**
   * Get auth state
   */
  getAuthState(): AuthState {
    return {
      isAuthenticated: this.isAuthenticated(),
      apiKey: this.apiKey,
      expiresAt: this.expiresAt
    };
  }

  /**
   * Validate API key format
   */
  validateApiKeyFormat(apiKey: string): boolean {
    // VaultSync API keys should start with 'vb_live_' or 'vb_test_'
    return /^vb_(live|test)_[a-zA-Z0-9]{32,}$/.test(apiKey);
  }

  /**
   * Start checking for token expiration
   */
  private startExpirationCheck(): void {
    // Stop existing interval if any
    this.stopExpirationCheck();

    // Check every hour
    this.expirationCheckInterval = setInterval(() => {
      if (this.isTokenExpired()) {
        console.debug('API key has expired');
        this.eventBus.emit(EVENTS.AUTH_TOKEN_EXPIRED);
        void this.clearApiKey();
      } else if (this.isTokenExpiringSoon()) {
        const days = this.getDaysUntilExpiration();
        console.debug(`API key expires in ${days} days`);
      }
    }, 60 * 60 * 1000); // Check every hour
  }

  /**
   * Stop expiration checking
   */
  private stopExpirationCheck(): void {
    if (this.expirationCheckInterval) {
      clearInterval(this.expirationCheckInterval);
      this.expirationCheckInterval = null;
    }
  }

  /**
   * Subscribe to auth state changes
   */
  onAuthStateChanged(callback: (isAuthenticated: boolean) => void): () => void {
    return this.eventBus.on(EVENTS.AUTH_STATE_CHANGED, callback);
  }

  /**
   * Subscribe to token expiration
   */
  onTokenExpired(callback: () => void): () => void {
    return this.eventBus.on(EVENTS.AUTH_TOKEN_EXPIRED, callback);
  }

  /**
   * Request device code for OAuth-style flow
   */
  async requestDeviceCode(apiBaseUrl: string): Promise<DeviceCodeResponse> {
    const response = await requestUrl({
      url: `${apiBaseUrl}/auth/device/code`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: 'obsidian-plugin',
        scope: 'vault:read vault:write file:read file:write',
      }),
      throw: false
    });

    if (response.status >= 400) {
      const error = response.json;
      throw new Error(error.error?.message || 'Failed to request device code');
    }

    return response.json;
  }

  /**
   * Poll for token (used during device authorization flow)
   */
  async pollForToken(apiBaseUrl: string, deviceCode: string): Promise<TokenResponse | null> {
    const response = await requestUrl({
      url: `${apiBaseUrl}/auth/device/token`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_code: deviceCode,
      }),
      throw: false
    });

    if (response.status >= 400) {
      const error = response.json;

      // These are expected errors during polling
      if (error.error === 'authorization_pending') {
        return null; // User hasn't authorized yet
      }

      if (error.error === 'expired_token') {
        throw new Error('Authorization code expired. Please try again.');
      }

      if (error.error === 'access_denied') {
        throw new Error('Authorization was denied.');
      }

      throw new Error(error.error_description || 'Failed to get token');
    }

    return response.json;
  }

  /**
   * Start device authorization flow
   * Returns a promise that resolves when the user authorizes
   */
  async startDeviceAuthFlow(apiBaseUrl: string, onCodeReceived: (userCode: string, verificationUri: string) => void): Promise<AuthResult> {
    // Step 1: Request device code
    const deviceCodeData = await this.requestDeviceCode(apiBaseUrl);

    // Notify caller of the user code and verification URI
    onCodeReceived(deviceCodeData.user_code, deviceCodeData.verification_uri_complete);

    // Step 2: Poll for token
    const pollInterval = deviceCodeData.interval * 1000; // Convert to milliseconds
    const expiresAt = Date.now() + deviceCodeData.expires_in * 1000;

    return new Promise((resolve, reject) => {
      const poll = async () => {
        try {
          // Check if expired
          if (Date.now() >= expiresAt) {
            clearInterval(intervalId);
            reject(new Error('Authorization timed out. Please try again.'));
            return;
          }

          // Poll for token
          const tokenData = await this.pollForToken(apiBaseUrl, deviceCodeData.device_code);

          if (tokenData) {
            // Got the token!
            clearInterval(intervalId);

            // Calculate expiration date
            const tokenExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

            // Store the API key
            await this.storeApiKey(tokenData.access_token, tokenExpiresAt);

            resolve({
              apiKey: tokenData.access_token,
              expiresAt: tokenExpiresAt,
              scopes: tokenData.scopes,
            });
          }
        } catch (error) {
          clearInterval(intervalId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      // Start polling
      const intervalId = setInterval(() => { void poll(); }, pollInterval);

      // Do first poll immediately
      void poll();
    });
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.stopExpirationCheck();
  }
}
