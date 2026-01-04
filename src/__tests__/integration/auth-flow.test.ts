/**
 * Integration Test: Authentication Flow
 * 
 * This test demonstrates the authentication flow integration.
 * Note: These tests require a running backend service and are typically
 * run separately from unit tests.
 */

import { AuthService } from '../../services/AuthService';
import { VaultService } from '../../services/VaultService';
import { APIClient } from '../../api/APIClient';
import { EventBus } from '../../core/EventBus';
import { Plugin } from 'obsidian';

describe.skip('Integration: Authentication Flow', () => {
  let authService: AuthService;
  let vaultService: VaultService;
  let apiClient: APIClient;
  let eventBus: EventBus;
  let mockPlugin: Plugin;

  beforeAll(() => {
    // Setup would require actual backend connection
    // This is skipped by default and should be run manually
  });

  beforeEach(() => {
    mockPlugin = {
      loadData: jest.fn().mockResolvedValue({}),
      saveData: jest.fn().mockResolvedValue(undefined)
    } as Partial<Plugin> as Plugin;

    eventBus = new EventBus();
    authService = new AuthService(mockPlugin, eventBus);
    apiClient = new APIClient(authService, 'http://localhost:3000');
  });

  it('should complete full authentication flow', async () => {
    // 1. Store API key
    const apiKey = process.env.TEST_API_KEY || 'vb_test_12345678901234567890123456789012';
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 90);

    await authService.storeApiKey(apiKey, expiresAt);

    // 2. Verify authentication
    expect(authService.isAuthenticated()).toBe(true);

    // 3. Get API key
    const retrievedKey = await authService.getApiKey();
    expect(retrievedKey).toBe(apiKey);

    // 4. Clear API key
    await authService.clearApiKey();
    expect(authService.isAuthenticated()).toBe(false);
  });

  it('should handle token expiration', async () => {
    const apiKey = 'vb_test_12345678901234567890123456789012';
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() - 1); // Expired

    await authService.storeApiKey(apiKey, expiresAt);

    expect(authService.isTokenExpired()).toBe(true);
    expect(authService.isAuthenticated()).toBe(false);
  });
});
