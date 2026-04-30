import { SelectiveSyncService } from '../SelectiveSyncService';
import { EventBus } from '../../core/EventBus';
import { StorageManager } from '../../core/StorageManager';
import { TFile } from 'obsidian';

// Mock TFile for testing
class MockTFile {
  constructor(public path: string) {}
}

describe('SelectiveSyncService', () => {
  let service: SelectiveSyncService;
  let eventBus: EventBus;
  let storage: StorageManager;

  beforeEach(() => {
    eventBus = new EventBus();
    storage = {} as jest.Mocked<StorageManager>; // Mock storage
    service = new SelectiveSyncService(
      eventBus,
      storage,
      {
        includedFolders: [],
        excludedFolders: []
      },
      '.obsidian'
    );
  });

  describe('Default Exclusions', () => {
    it('should exclude .obsidian folder by default', () => {
      const file = new MockTFile('.obsidian/config.json') as unknown as TFile;
      expect(service.shouldSyncFile(file)).toBe(false);
    });

    it('should exclude .trash folder by default', () => {
      const file = new MockTFile('.trash/deleted.md') as unknown as TFile;
      expect(service.shouldSyncFile(file)).toBe(false);
    });

    it('should sync regular files by default', () => {
      const file = new MockTFile('notes/file.md') as unknown as TFile;
      expect(service.shouldSyncFile(file)).toBe(true);
    });
  });

  describe('Excluded Folders', () => {
    beforeEach(() => {
      service.setExcludedFolders(['private', 'drafts']);
    });

    it('should exclude files in excluded folders', () => {
      const file = new MockTFile('private/secret.md') as unknown as TFile;
      expect(service.shouldSyncFile(file)).toBe(false);
    });

    it('should exclude files in nested excluded folders', () => {
      const file = new MockTFile('private/nested/secret.md') as unknown as TFile;
      expect(service.shouldSyncFile(file)).toBe(false);
    });

    it('should sync files not in excluded folders', () => {
      const file = new MockTFile('public/file.md') as unknown as TFile;
      expect(service.shouldSyncFile(file)).toBe(true);
    });

    it('should maintain default exclusions', () => {
      const file = new MockTFile('.obsidian/config.json') as unknown as TFile;
      expect(service.shouldSyncFile(file)).toBe(false);
    });
  });

  describe('Included Folders', () => {
    beforeEach(() => {
      service.setIncludedFolders(['notes', 'docs']);
    });

    it('should sync files in included folders', () => {
      const file = new MockTFile('notes/file.md') as unknown as TFile;
      expect(service.shouldSyncFile(file)).toBe(true);
    });

    it('should not sync files outside included folders', () => {
      const file = new MockTFile('other/file.md') as unknown as TFile;
      expect(service.shouldSyncFile(file)).toBe(false);
    });

    it('should sync nested files in included folders', () => {
      const file = new MockTFile('notes/nested/file.md') as unknown as TFile;
      expect(service.shouldSyncFile(file)).toBe(true);
    });
  });

  describe('Included and Excluded Folders', () => {
    beforeEach(() => {
      service.setIncludedFolders(['notes']);
      service.setExcludedFolders(['notes/private']);
    });

    it('should exclude files even if in included folder', () => {
      const file = new MockTFile('notes/private/secret.md') as unknown as TFile;
      expect(service.shouldSyncFile(file)).toBe(false);
    });

    it('should sync files in included folder but not excluded', () => {
      const file = new MockTFile('notes/public/file.md') as unknown as TFile;
      expect(service.shouldSyncFile(file)).toBe(true);
    });
  });

  describe('Pattern Matching', () => {
    it('should match wildcard patterns', () => {
      service.setExcludedFolders(['*/temp']);
      
      const file1 = new MockTFile('project1/temp/file.md') as unknown as TFile;
      const file2 = new MockTFile('project2/temp/file.md') as unknown as TFile;
      
      expect(service.shouldSyncFile(file1)).toBe(false);
      expect(service.shouldSyncFile(file2)).toBe(false);
    });

    it('should match exact folder names', () => {
      service.setExcludedFolders(['temp']);
      
      const file1 = new MockTFile('temp/file.md') as unknown as TFile;
      const file2 = new MockTFile('temporary/file.md') as unknown as TFile;
      
      expect(service.shouldSyncFile(file1)).toBe(false);
      expect(service.shouldSyncFile(file2)).toBe(true);
    });
  });

  describe('Pattern Validation', () => {
    it('should validate correct patterns', () => {
      const result = service.validatePattern('notes/drafts');
      expect(result.valid).toBe(true);
    });

    it('should reject empty patterns', () => {
      const result = service.validatePattern('');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject patterns with invalid characters', () => {
      const result = service.validatePattern('notes<>:"|?');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject patterns with double slashes', () => {
      const result = service.validatePattern('notes//drafts');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('Folder Management', () => {
    it('should add excluded folder', () => {
      service.addExcludedFolder('private');
      const config = service.getConfig();
      expect(config.excludedFolders).toContain('private');
    });

    it('should remove excluded folder', () => {
      service.addExcludedFolder('private');
      service.removeExcludedFolder('private');
      const config = service.getConfig();
      expect(config.excludedFolders).not.toContain('private');
    });

    it('should not add duplicate excluded folders', () => {
      service.addExcludedFolder('private');
      service.addExcludedFolder('private');
      const config = service.getConfig();
      const count = config.excludedFolders.filter(f => f === 'private').length;
      expect(count).toBe(1);
    });

    it('should normalize folder paths', () => {
      service.addExcludedFolder('/private/');
      const config = service.getConfig();
      expect(config.excludedFolders).toContain('private');
    });
  });

  describe('Sync Scope Preview', () => {
    it('should calculate correct statistics', () => {
      service.setExcludedFolders(['private']);
      
      const files = [
        new MockTFile('notes/file1.md'),
        new MockTFile('notes/file2.md'),
        new MockTFile('private/secret.md'),
        new MockTFile('.obsidian/config.json')
      ] as unknown as TFile[];

      const stats = service.getSyncScopePreview(files);
      
      expect(stats.totalFiles).toBe(4);
      expect(stats.includedFiles).toBe(2);
      expect(stats.excludedFiles).toBe(2);
    });
  });

  describe('Reset and Clear', () => {
    it('should reset to default exclusions', () => {
      service.setExcludedFolders(['private', 'drafts']);
      service.resetExcludedFolders();
      
      const config = service.getConfig();
      expect(config.excludedFolders).toEqual(['.obsidian', '.trash']);
    });

    it('should clear included folders', () => {
      service.setIncludedFolders(['notes', 'docs']);
      service.clearIncludedFolders();
      
      const config = service.getConfig();
      expect(config.includedFolders).toEqual([]);
    });
  });

  describe('Selective Sync Status', () => {
    it('should detect when using default exclusions only', () => {
      expect(service.isUsingDefaultExclusionsOnly()).toBe(true);
      
      service.addExcludedFolder('private');
      expect(service.isUsingDefaultExclusionsOnly()).toBe(false);
    });

    it('should detect when selective sync is active', () => {
      expect(service.isSelectiveSyncActive()).toBe(false);
      
      service.addExcludedFolder('private');
      expect(service.isSelectiveSyncActive()).toBe(true);
      
      service.resetExcludedFolders();
      service.addIncludedFolder('notes');
      expect(service.isSelectiveSyncActive()).toBe(true);
    });
  });
});
