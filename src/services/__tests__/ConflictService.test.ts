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

    it('should load conflicts from storage', async () => {
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

    it('should detect content conflict', async () => {
      const mockFile = { path: 'test.md', stat: { mtime: Date.now() } } as TFile;
      mockFile.stat.mtime = Date.now();
      
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
      
      mockStorage.get.mockResolvedValue({});
      
      const conflict = await conflictService.checkFileConflict(
        mockFile,
        remoteHash,
        new Date()
      );
      
      expect(conflict).not.toBeNull();
      expect(conflict?.conflictType).toBe(ConflictType.CONTENT);
      expect(conflict?.localContent).toBe(localContent);
      expect(conflict?.remoteContent).toBe(remoteContent);
    });
  });

  describe('Get Conflicts', () => {
    beforeEach(async () => {
      const conflicts = [
        {
          id: 'conflict-1',
          path: 'file1.md',
          localContent: 'local1',
          remoteContent: 'remote1',
          localModified: new Date('2024-01-01'),
          remoteModified: new Date('2024-01-02'),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        },
        {
          id: 'conflict-2',
          path: 'file2.md',
          localContent: 'local2',
          remoteContent: 'remote2',
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
          localContent: 'local content',
          remoteContent: 'remote content',
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
          localContent: 'local content',
          remoteContent: 'remote content',
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
          localContent: 'local content',
          remoteContent: 'remote content',
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
          localContent: 'local content',
          remoteContent: 'remote content',
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
          localContent: 'local',
          remoteContent: 'remote',
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
          localContent: 'local1',
          remoteContent: 'remote1',
          localModified: new Date('2024-01-01'),
          remoteModified: new Date('2024-01-02'),
          conflictType: ConflictType.CONTENT,
          autoResolvable: false
        },
        {
          id: 'conflict-2',
          path: 'test2.md',
          localContent: 'local2',
          remoteContent: 'remote2',
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
