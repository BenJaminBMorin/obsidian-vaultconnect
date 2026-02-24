import { ConflictService } from '../ConflictService';
import { APIClient } from '../../api/APIClient';
import { EventBus, EVENTS } from '../../core/EventBus';
import { StorageManager } from '../../core/StorageManager';
import { Vault, TFile } from 'obsidian';
import { ConflictType, ResolutionStrategy } from '../../types';

describe('ConflictService', () => {
  let conflictService: ConflictService;
  let mockVault: jest.Mocked<Vault>;
  let mockApiClient: jest.Mocked<APIClient>;
  let mockStorage: jest.Mocked<StorageManager>;
  let eventBus: EventBus;

  beforeEach(() => {
    mockVault = {
      read: jest.fn(),
      modify: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      getAbstractFileByPath: jest.fn(),
      getMarkdownFiles: jest.fn()
    } as jest.Mocked<Vault>;

    mockApiClient = {
      listFiles: jest.fn(),
      getFileByPath: jest.fn(),
      updateFile: jest.fn(),
      createFile: jest.fn(),
      deleteFile: jest.fn(),
      fileExists: jest.fn()
    } as jest.Mocked<APIClient>;

    mockStorage = {
      get: jest.fn(),
      set: jest.fn()
    } as jest.Mocked<StorageManager>;

    eventBus = new EventBus();
    conflictService = new ConflictService(mockVault, mockApiClient, eventBus, mockStorage);
  });

  describe('Initialization', () => {
    it('should initialize with vault ID', async () => {
      mockStorage.get.mockResolvedValue([]);

      await conflictService.initialize('vault-123');

      expect(mockStorage.get).toHaveBeenCalledWith('conflicts');
    });

    it('should load conflicts from storage (content stripped)', async () => {
      const storedConflicts = [
        {
          id: 'conflict-1',
          path: 'test.md',
          localContent: 'local',
          remoteContent: 'remote',
          localModified: new Date('2024-01-01').toISOString(),
          remoteModified: new Date('2024-01-02').toISOString(),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        }
      ];
      mockStorage.get.mockResolvedValue(storedConflicts);

      await conflictService.initialize('vault-123');

      const conflicts = conflictService.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].id).toBe('conflict-1');
      // Content should be stripped during migration
      expect(conflicts[0].localContent).toBeUndefined();
      expect(conflicts[0].remoteContent).toBeUndefined();
    });

    it('should migrate bloated data on load (re-save without content)', async () => {
      const storedConflicts = [
        {
          id: 'conflict-1',
          path: 'test.md',
          localContent: 'huge local content',
          remoteContent: 'huge remote content',
          localModified: new Date().toISOString(),
          remoteModified: new Date().toISOString(),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        }
      ];
      mockStorage.get.mockResolvedValue(storedConflicts);

      await conflictService.initialize('vault-123');

      // Should re-save without content (migration)
      expect(mockStorage.set).toHaveBeenCalledWith('conflicts', expect.arrayContaining([
        expect.objectContaining({
          id: 'conflict-1',
          localContent: undefined,
          remoteContent: undefined
        })
      ]));
    });

    it('should clean up stale conflicts (older than 7 days)', async () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const storedConflicts = [
        {
          id: 'stale-conflict',
          path: 'old.md',
          localModified: eightDaysAgo.toISOString(),
          remoteModified: eightDaysAgo.toISOString(),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        },
        {
          id: 'fresh-conflict',
          path: 'new.md',
          localModified: new Date().toISOString(),
          remoteModified: new Date().toISOString(),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        }
      ];
      mockStorage.get.mockResolvedValue(storedConflicts);

      await conflictService.initialize('vault-123');

      expect(conflictService.getConflictCount()).toBe(1);
      expect(conflictService.getConflict('fresh-conflict')).not.toBeNull();
      expect(conflictService.getConflict('stale-conflict')).toBeNull();
    });
  });

  describe('Conflict Detection', () => {
    it('should detect no conflicts when files match', async () => {
      const mockFile = { path: 'test.md', stat: { mtime: Date.now() } } as TFile;
      mockFile.stat.mtime = Date.now();

      const content = 'content';
      const hash = await computeHash(content);

      mockVault.read.mockResolvedValue(content);
      mockStorage.get.mockResolvedValue({
        'test.md': Date.now()
      });

      const conflict = await conflictService.checkFileConflict(
        mockFile,
        hash,
        new Date()
      );

      expect(conflict).toBeNull();
    });

    it('should detect content conflict and store hashes', async () => {
      mockStorage.get.mockResolvedValue([]);
      await conflictService.initialize('vault-123');

      const mockFile = { path: 'test.md', stat: { mtime: Date.now() } } as TFile;

      const localContent = 'local content';
      const remoteContent = 'remote content';
      const remoteHash = await computeHash(remoteContent);

      mockVault.read.mockResolvedValue(localContent);
      mockApiClient.getFileByPath.mockResolvedValue({
        file_id: 'file-1',
        path: 'test.md',
        content: remoteContent,
        hash: remoteHash,
        updated_at: new Date()
      });

      // Return empty objects for lastSyncTimestamps and fileHashes
      mockStorage.get
        .mockResolvedValueOnce({})  // lastSyncTimestamps
        .mockResolvedValueOnce({});  // fileHashes

      const conflict = await conflictService.checkFileConflict(
        mockFile,
        remoteHash,
        new Date()
      );

      expect(conflict).not.toBeNull();
      expect(conflict?.conflictType).toBe(ConflictType.CONTENT);
      // Content is kept in memory for immediate UI use
      expect(conflict?.localContent).toBe(localContent);
      expect(conflict?.remoteContent).toBe(remoteContent);
      // Hashes should be stored
      expect(conflict?.localHash).toBeDefined();
      expect(conflict?.remoteHash).toBe(remoteHash);
    });

    it('should auto-resolve when content is identical', async () => {
      mockStorage.get.mockResolvedValue([]);
      await conflictService.initialize('vault-123');

      const mockFile = { path: 'test.md', stat: { mtime: Date.now() } } as TFile;

      const content = 'same content';
      const localHash = await computeHash(content);
      const remoteHash = await computeHash('different for hash mismatch');

      mockVault.read.mockResolvedValue(content);
      mockApiClient.getFileByPath.mockResolvedValue({
        file_id: 'file-1',
        path: 'test.md',
        content: content, // Same content despite different hash
        hash: remoteHash,
        updated_at: new Date()
      });

      mockStorage.get
        .mockResolvedValueOnce({})  // lastSyncTimestamps
        .mockResolvedValueOnce({})  // fileHashes
        .mockResolvedValueOnce({})  // lastSyncTimestamps (updateSyncState)
        .mockResolvedValueOnce({}); // fileHashes (updateSyncState)

      const conflict = await conflictService.checkFileConflict(
        mockFile,
        remoteHash,
        new Date()
      );

      // Should return null (auto-resolved)
      expect(conflict).toBeNull();
    });

    it('should dedup conflicts by path', async () => {
      const storedConflicts = [
        {
          id: 'old-conflict',
          path: 'test.md',
          localModified: new Date().toISOString(),
          remoteModified: new Date().toISOString(),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        }
      ];
      mockStorage.get.mockResolvedValue(storedConflicts);
      await conflictService.initialize('vault-123');

      expect(conflictService.getConflictCount()).toBe(1);

      const mockFile = { path: 'test.md', stat: { mtime: Date.now() } } as TFile;
      const localContent = 'new local';
      const remoteContent = 'new remote';
      const remoteHash = await computeHash(remoteContent);

      mockVault.read.mockResolvedValue(localContent);
      mockApiClient.getFileByPath.mockResolvedValue({
        file_id: 'file-1',
        path: 'test.md',
        content: remoteContent,
        hash: remoteHash,
        updated_at: new Date()
      });

      mockStorage.get
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await conflictService.checkFileConflict(mockFile, remoteHash, new Date());

      // Should still be 1 conflict (old one replaced)
      expect(conflictService.getConflictCount()).toBe(1);
      expect(conflictService.getConflict('old-conflict')).toBeNull();
    });
  });

  describe('Conflict Cap', () => {
    it('should enforce cap of 50 conflicts', async () => {
      // Create 55 conflicts
      const storedConflicts = Array.from({ length: 55 }, (_, i) => ({
        id: `conflict-${i}`,
        path: `file${i}.md`,
        localModified: new Date(Date.now() - (55 - i) * 1000).toISOString(),
        remoteModified: new Date().toISOString(),
        conflictType: ConflictType.CONTENT,
        autoResolvable: false
      }));
      mockStorage.get.mockResolvedValue(storedConflicts);
      await conflictService.initialize('vault-123');

      expect(conflictService.getConflictCount()).toBe(50);
      // Oldest conflicts should have been evicted
      expect(conflictService.getConflict('conflict-0')).toBeNull();
      expect(conflictService.getConflict('conflict-4')).toBeNull();
      // Newest should remain
      expect(conflictService.getConflict('conflict-54')).not.toBeNull();
    });
  });

  describe('On-Demand Content Fetching', () => {
    it('should fetch content on-demand when not in memory', async () => {
      const storedConflicts = [
        {
          id: 'conflict-1',
          path: 'test.md',
          // No localContent/remoteContent (stripped on load)
          localModified: new Date().toISOString(),
          remoteModified: new Date().toISOString(),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        }
      ];
      mockStorage.get.mockResolvedValue(storedConflicts);
      await conflictService.initialize('vault-123');

      const mockFile = { path: 'test.md' } as TFile;
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue('current local content');
      mockApiClient.getFileByPath.mockResolvedValue({
        file_id: 'file-1',
        path: 'test.md',
        content: 'current remote content',
        hash: 'hash',
        updated_at: new Date()
      });

      const { localContent, remoteContent } = await conflictService.getConflictContent('conflict-1');
      expect(localContent).toBe('current local content');
      expect(remoteContent).toBe('current remote content');
    });
  });

  describe('Persistence', () => {
    it('should strip content when saving to storage', async () => {
      mockStorage.get.mockResolvedValue([]);
      await conflictService.initialize('vault-123');

      const mockFile = { path: 'test.md', stat: { mtime: Date.now() } } as TFile;
      const remoteHash = await computeHash('remote');

      mockVault.read.mockResolvedValue('local');
      mockApiClient.getFileByPath.mockResolvedValue({
        file_id: 'file-1',
        path: 'test.md',
        content: 'remote',
        hash: remoteHash,
        updated_at: new Date()
      });
      mockStorage.get
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await conflictService.checkFileConflict(mockFile, remoteHash, new Date());

      // Check that storage.set was called with content stripped
      const savedConflicts = mockStorage.set.mock.calls.find(
        call => call[0] === 'conflicts'
      );
      expect(savedConflicts).toBeDefined();
      const conflicts = savedConflicts![1] as any[];
      expect(conflicts[0].localContent).toBeUndefined();
      expect(conflicts[0].remoteContent).toBeUndefined();
    });
  });

  describe('Get Conflicts', () => {
    beforeEach(async () => {
      const conflicts = [
        {
          id: 'conflict-1',
          path: 'file1.md',
          localModified: new Date('2024-01-01'),
          remoteModified: new Date('2024-01-02'),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        },
        {
          id: 'conflict-2',
          path: 'file2.md',
          localModified: new Date('2024-01-01'),
          remoteModified: new Date('2024-01-02'),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        }
      ];
      mockStorage.get.mockResolvedValue(conflicts);
      await conflictService.initialize('vault-123');
    });

    it('should return all conflicts', () => {
      const conflicts = conflictService.getConflicts();
      expect(conflicts).toHaveLength(2);
    });

    it('should get conflict by ID', () => {
      const conflict = conflictService.getConflict('conflict-1');
      expect(conflict).not.toBeNull();
      expect(conflict?.path).toBe('file1.md');
    });

    it('should return null for non-existent conflict', () => {
      const conflict = conflictService.getConflict('non-existent');
      expect(conflict).toBeNull();
    });

    it('should get conflicts for specific file', () => {
      const conflicts = conflictService.getConflictsForFile('file1.md');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].id).toBe('conflict-1');
    });

    it('should check if file has conflicts', () => {
      expect(conflictService.hasConflicts('file1.md')).toBe(true);
      expect(conflictService.hasConflicts('file3.md')).toBe(false);
    });

    it('should get conflict count', () => {
      expect(conflictService.getConflictCount()).toBe(2);
    });
  });

  describe('Resolve Conflict - Keep Local', () => {
    beforeEach(async () => {
      const conflicts = [
        {
          id: 'conflict-1',
          path: 'test.md',
          localModified: new Date('2024-01-01'),
          remoteModified: new Date('2024-01-02'),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        }
      ];
      mockStorage.get.mockResolvedValue(conflicts);
      await conflictService.initialize('vault-123');
    });

    it('should keep local version', async () => {
      const mockFile = { path: 'test.md', stat: { mtime: Date.now() } } as TFile;
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue('local content');
      mockApiClient.fileExists.mockResolvedValue(true);
      mockApiClient.getFileByPath.mockResolvedValue({
        file_id: 'file-1',
        path: 'test.md',
        content: 'remote content',
        hash: 'hash',
        updated_at: new Date()
      });
      mockApiClient.updateFile.mockResolvedValue(undefined);

      await conflictService.resolveConflict('conflict-1', {
        strategy: ResolutionStrategy.KEEP_LOCAL
      });

      expect(mockApiClient.updateFile).toHaveBeenCalled();
      expect(conflictService.getConflict('conflict-1')).toBeNull();
    });
  });

  describe('Resolve Conflict - Keep Remote', () => {
    beforeEach(async () => {
      const conflicts = [
        {
          id: 'conflict-1',
          path: 'test.md',
          localModified: new Date('2024-01-01'),
          remoteModified: new Date('2024-01-02'),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        }
      ];
      mockStorage.get.mockResolvedValue(conflicts);
      await conflictService.initialize('vault-123');
    });

    it('should keep remote version', async () => {
      const mockFile = { path: 'test.md', stat: { mtime: Date.now() } } as TFile;
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockApiClient.getFileByPath.mockResolvedValue({
        file_id: 'file-1',
        path: 'test.md',
        content: 'remote content',
        hash: 'hash',
        updated_at: new Date()
      });
      mockVault.modify.mockResolvedValue(undefined);

      await conflictService.resolveConflict('conflict-1', {
        strategy: ResolutionStrategy.KEEP_REMOTE
      });

      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, 'remote content');
      expect(conflictService.getConflict('conflict-1')).toBeNull();
    });
  });

  describe('Resolve Conflict - Keep Both', () => {
    beforeEach(async () => {
      const conflicts = [
        {
          id: 'conflict-1',
          path: 'test.md',
          localModified: new Date('2024-01-01'),
          remoteModified: new Date('2024-01-02'),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        }
      ];
      mockStorage.get.mockResolvedValue(conflicts);
      await conflictService.initialize('vault-123');
    });

    it('should keep both versions', async () => {
      const mockFile = { path: 'test.md', stat: { mtime: Date.now() } } as TFile;
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue('local content');
      mockVault.create.mockResolvedValue({ path: 'test.conflict.md', stat: { mtime: Date.now() } } as TFile);
      mockApiClient.getFileByPath.mockResolvedValue({
        file_id: 'file-1',
        path: 'test.md',
        content: 'remote content',
        hash: 'hash',
        updated_at: new Date()
      });
      mockVault.modify.mockResolvedValue(undefined);

      await conflictService.resolveConflict('conflict-1', {
        strategy: ResolutionStrategy.KEEP_BOTH
      });

      expect(mockVault.create).toHaveBeenCalled();
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, 'remote content');
      expect(conflictService.getConflict('conflict-1')).toBeNull();
    });
  });

  describe('Resolve Conflict - Manual Merge', () => {
    beforeEach(async () => {
      const conflicts = [
        {
          id: 'conflict-1',
          path: 'test.md',
          localModified: new Date('2024-01-01'),
          remoteModified: new Date('2024-01-02'),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        }
      ];
      mockStorage.get.mockResolvedValue(conflicts);
      await conflictService.initialize('vault-123');
    });

    it('should apply manual merge', async () => {
      const mockFile = { path: 'test.md', stat: { mtime: Date.now() } } as TFile;
      const mergedContent = 'merged content';

      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.modify.mockResolvedValue(undefined);
      mockApiClient.fileExists.mockResolvedValue(true);
      mockApiClient.getFileByPath.mockResolvedValue({
        file_id: 'file-1',
        path: 'test.md',
        content: 'remote content',
        hash: 'hash',
        updated_at: new Date()
      });
      mockApiClient.updateFile.mockResolvedValue(undefined);

      await conflictService.resolveConflict('conflict-1', {
        strategy: ResolutionStrategy.MERGE_MANUAL,
        mergedContent
      });

      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, mergedContent);
      expect(mockApiClient.updateFile).toHaveBeenCalled();
      expect(conflictService.getConflict('conflict-1')).toBeNull();
    });

    it('should throw error when merged content not provided', async () => {
      await expect(
        conflictService.resolveConflict('conflict-1', {
          strategy: ResolutionStrategy.MERGE_MANUAL
        })
      ).rejects.toThrow('Merged content is required');
    });
  });

  describe('Remove Conflict', () => {
    beforeEach(async () => {
      const conflicts = [
        {
          id: 'conflict-1',
          path: 'test.md',
          localModified: new Date('2024-01-01'),
          remoteModified: new Date('2024-01-02'),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        }
      ];
      mockStorage.get.mockResolvedValue(conflicts);
      await conflictService.initialize('vault-123');
    });

    it('should remove conflict', async () => {
      await conflictService.removeConflict('conflict-1');

      expect(conflictService.getConflict('conflict-1')).toBeNull();
      expect(mockStorage.set).toHaveBeenCalled();
    });

    it('should emit conflict resolved event', async () => {
      const callback = jest.fn();
      eventBus.on(EVENTS.CONFLICT_RESOLVED, callback);

      await conflictService.removeConflict('conflict-1');

      expect(callback).toHaveBeenCalledWith({ conflictId: 'conflict-1' });
    });
  });

  describe('Clear All Conflicts', () => {
    beforeEach(async () => {
      const conflicts = [
        {
          id: 'conflict-1',
          path: 'test1.md',
          localModified: new Date('2024-01-01'),
          remoteModified: new Date('2024-01-02'),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        },
        {
          id: 'conflict-2',
          path: 'test2.md',
          localModified: new Date('2024-01-01'),
          remoteModified: new Date('2024-01-02'),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        }
      ];
      mockStorage.get.mockResolvedValue(conflicts);
      await conflictService.initialize('vault-123');
    });

    it('should clear all conflicts', async () => {
      await conflictService.clearAllConflicts();

      expect(conflictService.getConflictCount()).toBe(0);
      expect(mockStorage.set).toHaveBeenCalledWith('conflicts', []);
    });
  });
});

// Helper function to compute hash
async function computeHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
