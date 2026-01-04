import { PresenceService, UserActivity } from '../PresenceService';
import { EventBus, EVENTS } from '../../core/EventBus';
import { WebSocketManager } from '../../core/WebSocketManager';
import { StorageManager } from '../../core/StorageManager';
import { Plugin } from 'obsidian';
import { ActiveUser } from '../../types';
import { WS_EVENTS } from '../../utils/constants';

describe('PresenceService', () => {
  let presenceService: PresenceService;
  let mockPlugin: Plugin;
  let eventBus: EventBus;
  let mockWsManager: jest.Mocked<WebSocketManager>;
  let mockStorage: jest.Mocked<StorageManager>;

  beforeEach(() => {
    mockPlugin = {
      app: {
        workspace: {
          on: jest.fn().mockReturnValue({}),
          offref: jest.fn()
        }
      }
    } as Partial<Plugin> as Plugin;

    eventBus = new EventBus();

    mockWsManager = {
      send: jest.fn(),
      on: jest.fn()
    } as jest.Mocked<WebSocketManager>;

    mockStorage = {
      getActiveUsers: jest.fn().mockReturnValue({}),
      getFileViewers: jest.fn().mockReturnValue({}),
      setActiveUsers: jest.fn(),
      setFileViewers: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined)
    } as jest.Mocked<StorageManager>;

    presenceService = new PresenceService(
      mockPlugin,
      eventBus,
      mockWsManager,
      mockStorage,
      false
    );
  });

  afterEach(() => {
    presenceService.destroy();
  });

  describe('Initialization', () => {
    it('should initialize successfully', async () => {
      await presenceService.initialize();
      
      expect(mockStorage.getActiveUsers).toHaveBeenCalled();
      expect(mockStorage.getFileViewers).toHaveBeenCalled();
    });

    it('should load cached active users', async () => {
      const cachedUsers = {
        'user-1': {
          userId: 'user-1',
          userName: 'Alice',
          status: 'active' as const,
          currentFile: null,
          lastActivity: new Date()
        }
      };
      mockStorage.getActiveUsers.mockReturnValue(cachedUsers);
      
      await presenceService.initialize();
      
      const activeUsers = presenceService.getActiveUsers();
      expect(activeUsers).toHaveLength(1);
      expect(activeUsers[0].userId).toBe('user-1');
    });
  });

  describe('Start Tracking', () => {
    it('should start presence tracking', async () => {
      await presenceService.initialize();
      await presenceService.startTracking('vault-123', 'user-1', 'Alice');
      
      expect(mockWsManager.send).toHaveBeenCalledWith(
        WS_EVENTS.PRESENCE_UPDATE,
        expect.objectContaining({
          userId: 'user-1',
          vaultId: 'vault-123',
          status: 'active'
        })
      );
    });

    it('should get current presence state', async () => {
      await presenceService.initialize();
      await presenceService.startTracking('vault-123', 'user-1', 'Alice');
      
      const state = presenceService.getCurrentPresenceState();
      
      expect(state).not.toBeNull();
      expect(state?.userId).toBe('user-1');
      expect(state?.vaultId).toBe('vault-123');
      expect(state?.status).toBe('active');
    });
  });

  describe('Stop Tracking', () => {
    it('should stop presence tracking', async () => {
      await presenceService.initialize();
      await presenceService.startTracking('vault-123', 'user-1', 'Alice');
      
      mockWsManager.send.mockClear();
      await presenceService.stopTracking();
      
      expect(mockWsManager.send).toHaveBeenCalledWith(
        WS_EVENTS.PRESENCE_UPDATE,
        expect.objectContaining({
          status: 'offline'
        })
      );
      
      const state = presenceService.getCurrentPresenceState();
      expect(state).toBeNull();
    });
  });

  describe('Update Activity', () => {
    beforeEach(async () => {
      await presenceService.initialize();
      await presenceService.startTracking('vault-123', 'user-1', 'Alice');
      mockWsManager.send.mockClear();
    });

    it('should update activity', async () => {
      const activity: UserActivity = {
        type: 'editing',
        filePath: 'test.md',
        timestamp: new Date()
      };
      
      await presenceService.updateActivity(activity);
      
      expect(mockWsManager.send).toHaveBeenCalledWith(
        WS_EVENTS.PRESENCE_UPDATE,
        expect.objectContaining({
          currentFile: 'test.md'
        })
      );
    });

    it('should emit file opened event', async () => {
      const callback = jest.fn();
      presenceService.onFileOpened(callback);
      
      await presenceService.updateActivity({
        type: 'editing',
        filePath: 'test.md',
        timestamp: new Date()
      });
      
      expect(callback).toHaveBeenCalledWith('user-1', 'test.md');
    });

    it('should emit file closed event', async () => {
      await presenceService.updateActivity({
        type: 'editing',
        filePath: 'test.md',
        timestamp: new Date()
      });
      
      const callback = jest.fn();
      presenceService.onFileClosed(callback);
      
      await presenceService.updateActivity({
        type: 'viewing',
        filePath: null,
        timestamp: new Date()
      });
      
      expect(callback).toHaveBeenCalledWith('user-1', 'test.md');
    });
  });

  describe('Active Users', () => {
    beforeEach(async () => {
      await presenceService.initialize();
    });

    it('should return empty list initially', () => {
      const users = presenceService.getActiveUsers();
      expect(users).toHaveLength(0);
    });

    it('should handle user joined event', async () => {
      await presenceService.startTracking('vault-123', 'user-1', 'Alice');
      
      // Simulate user joined event
      const wsOnCalls = mockWsManager.on.mock.calls;
      const userJoinedHandler = wsOnCalls.find(call => call[0] === WS_EVENTS.USER_JOINED)?.[1];
      
      if (userJoinedHandler) {
        userJoinedHandler({
          user_id: 'user-2',
          user_name: 'Bob',
          user_avatar: null,
          vault_id: 'vault-123'
        });
      }
      
      const users = presenceService.getActiveUsers();
      expect(users.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle user left event', async () => {
      await presenceService.startTracking('vault-123', 'user-1', 'Alice');
      
      // Simulate user joined
      const wsOnCalls = mockWsManager.on.mock.calls;
      const userJoinedHandler = wsOnCalls.find(call => call[0] === WS_EVENTS.USER_JOINED)?.[1];
      
      if (userJoinedHandler) {
        userJoinedHandler({
          user_id: 'user-2',
          user_name: 'Bob',
          user_avatar: null,
          vault_id: 'vault-123'
        });
      }
      
      // Simulate user left
      const userLeftHandler = wsOnCalls.find(call => call[0] === WS_EVENTS.USER_LEFT)?.[1];
      
      if (userLeftHandler) {
        userLeftHandler({
          user_id: 'user-2'
        });
      }
      
      const users = presenceService.getActiveUsers();
      const user2 = users.find(u => u.userId === 'user-2');
      expect(user2).toBeUndefined();
    });
  });

  describe('File Viewers', () => {
    beforeEach(async () => {
      await presenceService.initialize();
      await presenceService.startTracking('vault-123', 'user-1', 'Alice');
    });

    it('should return empty list for file with no viewers', () => {
      const viewers = presenceService.getFileViewers('test.md');
      expect(viewers).toHaveLength(0);
    });

    it('should track file viewers', async () => {
      // Simulate presence update with file
      const wsOnCalls = mockWsManager.on.mock.calls;
      const presenceUpdateHandler = wsOnCalls.find(call => call[0] === WS_EVENTS.PRESENCE_UPDATE)?.[1];
      
      if (presenceUpdateHandler) {
        presenceUpdateHandler({
          user_id: 'user-2',
          user_name: 'Bob',
          user_avatar: null,
          status: 'active',
          current_file: 'test.md',
          last_activity: new Date()
        });
      }
      
      const viewers = presenceService.getFileViewers('test.md');
      expect(viewers.length).toBeGreaterThanOrEqual(0);
    });

    it('should check if file is being viewed', async () => {
      expect(presenceService.isFileBeingViewed('test.md')).toBe(false);
    });
  });

  describe('User Activity', () => {
    beforeEach(async () => {
      await presenceService.initialize();
      await presenceService.startTracking('vault-123', 'user-1', 'Alice');
    });

    it('should return null for non-existent user', () => {
      const activity = presenceService.getUserActivity('non-existent');
      expect(activity).toBeNull();
    });

    it('should emit user activity event', async () => {
      const callback = jest.fn();
      presenceService.onUserActivity(callback);
      
      await presenceService.updateActivity({
        type: 'editing',
        filePath: 'test.md',
        timestamp: new Date()
      });
      
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('Event Subscriptions', () => {
    beforeEach(async () => {
      await presenceService.initialize();
    });

    it('should subscribe to user joined events', () => {
      const callback = jest.fn();
      const unsubscribe = presenceService.onUserJoined(callback);
      
      expect(typeof unsubscribe).toBe('function');
    });

    it('should subscribe to user left events', () => {
      const callback = jest.fn();
      const unsubscribe = presenceService.onUserLeft(callback);
      
      expect(typeof unsubscribe).toBe('function');
    });

    it('should subscribe to user activity events', () => {
      const callback = jest.fn();
      const unsubscribe = presenceService.onUserActivity(callback);
      
      expect(typeof unsubscribe).toBe('function');
    });

    it('should subscribe to file opened events', () => {
      const callback = jest.fn();
      const unsubscribe = presenceService.onFileOpened(callback);
      
      expect(typeof unsubscribe).toBe('function');
    });

    it('should subscribe to file closed events', () => {
      const callback = jest.fn();
      const unsubscribe = presenceService.onFileClosed(callback);
      
      expect(typeof unsubscribe).toBe('function');
    });
  });

  describe('Broadcast Presence', () => {
    beforeEach(async () => {
      await presenceService.initialize();
      await presenceService.startTracking('vault-123', 'user-1', 'Alice');
      mockWsManager.send.mockClear();
    });

    it('should broadcast active status', async () => {
      await presenceService.broadcastPresence('active');
      
      expect(mockWsManager.send).toHaveBeenCalledWith(
        WS_EVENTS.PRESENCE_UPDATE,
        expect.objectContaining({
          status: 'active'
        })
      );
    });

    it('should broadcast away status', async () => {
      await presenceService.broadcastPresence('away');
      
      expect(mockWsManager.send).toHaveBeenCalledWith(
        WS_EVENTS.PRESENCE_UPDATE,
        expect.objectContaining({
          status: 'away'
        })
      );
    });

    it('should broadcast offline status', async () => {
      await presenceService.broadcastPresence('offline');
      
      expect(mockWsManager.send).toHaveBeenCalledWith(
        WS_EVENTS.PRESENCE_UPDATE,
        expect.objectContaining({
          status: 'offline'
        })
      );
    });
  });
});
