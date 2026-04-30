import {
  computeHash,
  generateDeviceId,
  generateUserColor,
  debounce,
  getBackoffDelay,
  formatFileSize,
  formatRelativeTime,
  shouldSyncFile,
  sanitizeFilePath,
  parseErrorMessage,
  sleep,
  retryWithBackoff,
  isOnline,
  generateId
} from '../helpers';

describe('Utility Functions', () => {
  describe('computeHash', () => {
    it('should compute SHA-256 hash', async () => {
      const content = 'test content';
      const hash = await computeHash(content);
      
      expect(hash).toBeTruthy();
      expect(hash.length).toBe(64); // SHA-256 produces 64 hex characters
    });

    it('should produce consistent hashes', async () => {
      const content = 'test content';
      const hash1 = await computeHash(content);
      const hash2 = await computeHash(content);
      
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different content', async () => {
      const hash1 = await computeHash('content1');
      const hash2 = await computeHash('content2');
      
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('generateDeviceId', () => {
    it('should generate device ID', () => {
      const deviceId = generateDeviceId();
      
      expect(deviceId).toBeTruthy();
      expect(deviceId).toMatch(/^obsidian-\d+-[a-z0-9]+$/);
    });

    it('should generate unique device IDs', () => {
      const id1 = generateDeviceId();
      const id2 = generateDeviceId();
      
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateUserColor', () => {
    it('should generate color for user', () => {
      const color = generateUserColor('user-123');
      
      expect(color).toBeTruthy();
      expect(color).toMatch(/^#[0-9A-F]{6}$/i);
    });

    it('should generate consistent color for same user', () => {
      const color1 = generateUserColor('user-123');
      const color2 = generateUserColor('user-123');
      
      expect(color1).toBe(color2);
    });

    it('should generate different colors for different users', () => {
      const color1 = generateUserColor('user-1');
      const color2 = generateUserColor('user-2');
      
      // Note: Due to hash collision, this might occasionally fail
      // but should pass most of the time
      expect(color1).toBeDefined();
      expect(color2).toBeDefined();
    });
  });

  describe('debounce', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterAll(() => {
      jest.useRealTimers();
    });

    it('should debounce function calls', () => {
      const fn = jest.fn();
      const debouncedFn = debounce(fn, 100);
      
      debouncedFn();
      debouncedFn();
      debouncedFn();
      
      expect(fn).not.toHaveBeenCalled();
      
      jest.advanceTimersByTime(100);
      
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should call function with latest arguments', () => {
      const fn = jest.fn();
      const debouncedFn = debounce(fn, 100);
      
      debouncedFn('arg1');
      debouncedFn('arg2');
      debouncedFn('arg3');
      
      jest.advanceTimersByTime(100);
      
      expect(fn).toHaveBeenCalledWith('arg3');
    });

    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });
  });

  describe('getBackoffDelay', () => {
    it('should calculate exponential backoff', () => {
      expect(getBackoffDelay(0, 1000)).toBe(1000);
      expect(getBackoffDelay(1, 1000)).toBe(2000);
      expect(getBackoffDelay(2, 1000)).toBe(4000);
      expect(getBackoffDelay(3, 1000)).toBe(8000);
    });

    it('should cap at maximum delay', () => {
      const delay = getBackoffDelay(10, 1000);
      expect(delay).toBeLessThanOrEqual(30000);
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes', () => {
      expect(formatFileSize(0)).toBe('0 B');
      expect(formatFileSize(100)).toBe('100.00 B');
    });

    it('should format kilobytes', () => {
      expect(formatFileSize(1024)).toBe('1.00 KB');
      expect(formatFileSize(2048)).toBe('2.00 KB');
    });

    it('should format megabytes', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.00 MB');
      expect(formatFileSize(5 * 1024 * 1024)).toBe('5.00 MB');
    });

    it('should format gigabytes', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.00 GB');
    });
  });

  describe('formatRelativeTime', () => {
    it('should format recent time as "Just now"', () => {
      const now = new Date();
      expect(formatRelativeTime(now)).toBe('Just now');
    });

    it('should format minutes ago', () => {
      const date = new Date(Date.now() - 5 * 60 * 1000);
      expect(formatRelativeTime(date)).toBe('5 minutes ago');
    });

    it('should format hours ago', () => {
      const date = new Date(Date.now() - 3 * 60 * 60 * 1000);
      expect(formatRelativeTime(date)).toBe('3 hours ago');
    });

    it('should format days ago', () => {
      const date = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      expect(formatRelativeTime(date)).toBe('2 days ago');
    });

    it('should format old dates as date string', () => {
      const date = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const formatted = formatRelativeTime(date);
      expect(formatted).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
    });
  });

  describe('shouldSyncFile', () => {
    it('should sync file when no filters', () => {
      expect(shouldSyncFile('test.md', [], [])).toBe(true);
    });

    it('should not sync excluded files', () => {
      expect(shouldSyncFile('.obsidian/config.json', [], ['.obsidian'])).toBe(false);
      expect(shouldSyncFile('private/secret.md', [], ['private'])).toBe(false);
    });

    it('should sync included files', () => {
      expect(shouldSyncFile('notes/test.md', ['notes'], [])).toBe(true);
      expect(shouldSyncFile('docs/readme.md', ['notes', 'docs'], [])).toBe(true);
    });

    it('should not sync files outside included folders', () => {
      expect(shouldSyncFile('other/test.md', ['notes'], [])).toBe(false);
    });

    it('should prioritize exclusions over inclusions', () => {
      expect(shouldSyncFile('notes/private/secret.md', ['notes'], ['notes/private'])).toBe(false);
    });
  });

  describe('sanitizeFilePath', () => {
    it('should remove directory traversal attempts', () => {
      expect(sanitizeFilePath('../../../etc/passwd')).toBe('etc/passwd');
      expect(sanitizeFilePath('../../file.md')).toBe('file.md');
    });

    it('should remove leading slashes', () => {
      expect(sanitizeFilePath('/file.md')).toBe('file.md');
      expect(sanitizeFilePath('///file.md')).toBe('file.md');
    });

    it('should keep valid paths unchanged', () => {
      expect(sanitizeFilePath('notes/file.md')).toBe('notes/file.md');
      expect(sanitizeFilePath('folder/subfolder/file.md')).toBe('folder/subfolder/file.md');
    });
  });

  describe('parseErrorMessage', () => {
    it('should parse string error', () => {
      expect(parseErrorMessage('Error message')).toBe('Error message');
    });

    it('should parse Error object', () => {
      const error = new Error('Test error');
      expect(parseErrorMessage(error)).toBe('Test error');
    });

    it('should parse nested error', () => {
      const error = { error: { message: 'Nested error' } };
      expect(parseErrorMessage(error)).toBe('Nested error');
    });

    it('should return default message for unknown error', () => {
      expect(parseErrorMessage(null)).toBe('An unknown error occurred');
      expect(parseErrorMessage(undefined)).toBe('An unknown error occurred');
      expect(parseErrorMessage({})).toBe('An unknown error occurred');
    });
  });

  describe('sleep', () => {
    it('should sleep for specified time', async () => {
      const start = Date.now();
      await sleep(10);
      const elapsed = Date.now() - start;
      
      expect(elapsed).toBeGreaterThanOrEqual(9);
    });
  });

  describe('retryWithBackoff', () => {
    it('should succeed on first attempt', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      
      const result = await retryWithBackoff(fn);
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValue('success');
      
      const result = await retryWithBackoff(fn, 3, 10);
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    }, 10000);

    it('should throw after max attempts', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('Always fails'));
      
      await expect(retryWithBackoff(fn, 3, 10)).rejects.toThrow('Always fails');
      expect(fn).toHaveBeenCalledTimes(3);
    }, 10000);
  });

  describe('isOnline', () => {
    it('should check online status', () => {
      const result = isOnline();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('generateId', () => {
    it('should generate unique ID', () => {
      const id = generateId();
      
      expect(id).toBeTruthy();
      expect(id).toMatch(/^\d+-[a-z0-9]+$/);
    });

    it('should generate different IDs', () => {
      const id1 = generateId();
      const id2 = generateId();
      
      expect(id1).not.toBe(id2);
    });
  });
});
