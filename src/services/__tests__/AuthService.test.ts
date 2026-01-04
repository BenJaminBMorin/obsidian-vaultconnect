import { AuthService } from '../AuthService';
import { EventBus, EVENTS } from '../../core/EventBus';
import { Plugin } from 'obsidian';

describe('AuthService', () => {
  let authService: AuthService;
  let mockPlugin: Plugin;
  let eventBus: EventBus;
  let mockData: Record<string, unknown>;

  beforeEach(() => {
    mockData = {};
    mockPlugin = {
      loadData: jest.fn().mockResolvedValue(mockData),
      saveData: jest.fn().mockImplementation((data) => {
        mockData = data;
        return Promise.resolve();
      })
    } as Partial<Plugin> as Plugin;
    
    eventBus = new EventBus();
    authService = new AuthService(mockPlugin, eventBus);
  });

  afterEach(() => {
    authService.destroy();
  });

  describe('Initialization', () => {
    it('should initialize without stored API key', async () => {
      await authService.initialize();
      expect(authService.isAuthenticated()).toBe(false);
    });

    it('should load valid API key from storage', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      
      const storedData = {
        apiKey: 'vb_test_12345678901234567890123456789012',
        apiKeyExpires: futureDate.toISOString()
      };
      
      mockPlugin.loadData = jest.fn().mockResolvedValue(storedData);
      
      await authService.initialize();
      expect(authService.isAuthenticated()).toBe(true);
    });

    it('should clear expired API key on initialization', async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      
      const storedData = {
        apiKey: 'vb_test_12345678901234567890123456789012',
        apiKeyExpires: pastDate.toISOString()
      };
      
      mockPlugin.loadData = jest.fn().mockResolvedValue(storedData);
      
      await authService.initialize();
      expect(authService.isAuthenticated()).toBe(false);
    });
  });

  describe('API Key Storage', () => {
    it('should store API key successfully', async () => {
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90);
      
      await authService.storeApiKey(apiKey, expiresAt);
      
      expect(mockPlugin.saveData).toHaveBeenCalled();
      expect(mockData.apiKey).toBe(apiKey);
      expect(authService.isAuthenticated()).toBe(true);
    });

    it('should emit auth state changed event on store', async () => {
      const callback = jest.fn();
      authService.onAuthStateChanged(callback);
      
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90);
      
      await authService.storeApiKey(apiKey, expiresAt);
      
      expect(callback).toHaveBeenCalledWith(true);
    });
  });

  describe('API Key Retrieval', () => {
    it('should return API key when authenticated', async () => {
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90);
      
      await authService.storeApiKey(apiKey, expiresAt);
      
      const retrievedKey = await authService.getApiKey();
      expect(retrievedKey).toBe(apiKey);
    });

    it('should return null when not authenticated', async () => {
      const retrievedKey = await authService.getApiKey();
      expect(retrievedKey).toBeNull();
    });

    it('should return null and clear expired key', async () => {
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() - 1); // Expired
      
      await authService.storeApiKey(apiKey, expiresAt);
      
      const retrievedKey = await authService.getApiKey();
      expect(retrievedKey).toBeNull();
      expect(authService.isAuthenticated()).toBe(false);
    });
  });

  describe('API Key Clearing', () => {
    it('should clear API key successfully', async () => {
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90);
      
      await authService.storeApiKey(apiKey, expiresAt);
      await authService.clearApiKey();
      
      expect(authService.isAuthenticated()).toBe(false);
      expect(mockData.apiKey).toBeNull();
    });

    it('should emit auth state changed event on clear', async () => {
      const callback = jest.fn();
      authService.onAuthStateChanged(callback);
      
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90);
      
      await authService.storeApiKey(apiKey, expiresAt);
      callback.mockClear();
      
      await authService.clearApiKey();
      
      expect(callback).toHaveBeenCalledWith(false);
    });
  });

  describe('Authentication Status', () => {
    it('should return false when not authenticated', () => {
      expect(authService.isAuthenticated()).toBe(false);
    });

    it('should return true when authenticated with valid key', async () => {
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90);
      
      await authService.storeApiKey(apiKey, expiresAt);
      
      expect(authService.isAuthenticated()).toBe(true);
    });

    it('should return false when key is expired', async () => {
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() - 1);
      
      await authService.storeApiKey(apiKey, expiresAt);
      
      expect(authService.isAuthenticated()).toBe(false);
    });
  });

  describe('Token Expiration', () => {
    it('should detect expired token', async () => {
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() - 1);
      
      await authService.storeApiKey(apiKey, expiresAt);
      
      expect(authService.isTokenExpired()).toBe(true);
    });

    it('should detect valid token', async () => {
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90);
      
      await authService.storeApiKey(apiKey, expiresAt);
      
      expect(authService.isTokenExpired()).toBe(false);
    });

    it('should detect token expiring soon', async () => {
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 5); // 5 days
      
      await authService.storeApiKey(apiKey, expiresAt);
      
      expect(authService.isTokenExpiringSoon()).toBe(true);
    });

    it('should not detect token expiring soon when far future', async () => {
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);
      
      await authService.storeApiKey(apiKey, expiresAt);
      
      expect(authService.isTokenExpiringSoon()).toBe(false);
    });

    it('should calculate days until expiration', async () => {
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 10);
      
      await authService.storeApiKey(apiKey, expiresAt);
      
      const days = authService.getDaysUntilExpiration();
      expect(days).toBeGreaterThanOrEqual(9);
      expect(days).toBeLessThanOrEqual(11);
    });
  });

  describe('API Key Validation', () => {
    it('should validate correct API key format', () => {
      expect(authService.validateApiKeyFormat('vb_live_12345678901234567890123456789012')).toBe(true);
      expect(authService.validateApiKeyFormat('vb_test_12345678901234567890123456789012')).toBe(true);
    });

    it('should reject invalid API key format', () => {
      expect(authService.validateApiKeyFormat('invalid_key')).toBe(false);
      expect(authService.validateApiKeyFormat('vb_prod_123')).toBe(false);
      expect(authService.validateApiKeyFormat('12345678901234567890123456789012')).toBe(false);
    });
  });

  describe('Auth State', () => {
    it('should return correct auth state when not authenticated', () => {
      const state = authService.getAuthState();
      
      expect(state.isAuthenticated).toBe(false);
      expect(state.apiKey).toBeNull();
      expect(state.expiresAt).toBeNull();
    });

    it('should return correct auth state when authenticated', async () => {
      const apiKey = 'vb_test_12345678901234567890123456789012';
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90);
      
      await authService.storeApiKey(apiKey, expiresAt);
      
      const state = authService.getAuthState();
      
      expect(state.isAuthenticated).toBe(true);
      expect(state.apiKey).toBe(apiKey);
      expect(state.expiresAt).toEqual(expiresAt);
    });
  });
});
