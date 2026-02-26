/**
 * Utility helper functions
 */

/**
 * Compute SHA-256 hash of content
 */
export async function computeHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a unique device ID
 */
export function generateDeviceId(): string {
  return `obsidian-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Generate a unique color for a user
 */
export function generateUserColor(userId: string): string {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
    '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2',
    '#F8B739', '#52B788', '#E76F51', '#2A9D8F'
  ];
  
  // Generate consistent color based on userId
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  return colors[Math.abs(hash) % colors.length];
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;
  
  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      timeout = null;
      func(...args);
    };
    
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  };
}

/**
 * Exponential backoff delay
 */
export function getBackoffDelay(attempt: number, baseDelay: number = 1000): number {
  return Math.min(baseDelay * Math.pow(2, attempt), 30000); // Max 30 seconds
}

/**
 * Format file size
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Format relative time
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffSecs < 60) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  
  return date.toLocaleDateString();
}

/**
 * Check if file should be synced based on path
 */
export function shouldSyncFile(
  filePath: string,
  includedFolders: string[],
  excludedFolders: string[]
): boolean {
  // Check excluded folders first
  for (const folder of excludedFolders) {
    if (filePath.startsWith(folder + '/') || filePath === folder) {
      return false;
    }
  }
  
  // If no included folders specified, sync all (except excluded)
  if (includedFolders.length === 0) {
    return true;
  }
  
  // Check if file is in any included folder
  for (const folder of includedFolders) {
    if (filePath.startsWith(folder + '/') || filePath === folder) {
      return true;
    }
  }
  
  return false;
}

/**
 * Sanitize file path to prevent directory traversal
 */
export function sanitizeFilePath(path: string): string {
  return path.replace(/\.\./g, '').replace(/^\/+/, '');
}

/**
 * Parse error message
 */
export function parseErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = (error as Record<string, unknown>).message;
    if (typeof msg === 'string') return msg;
  }
  if (error && typeof error === 'object' && 'error' in error) {
    const nestedError = (error as Record<string, unknown>).error;
    if (nestedError && typeof nestedError === 'object' && 'message' in nestedError) {
      const msg = (nestedError as Record<string, unknown>).message;
      if (typeof msg === 'string') return msg;
    }
  }
  return 'An unknown error occurred';
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error represents a non-retryable client error (4xx except 429).
 * Returns true if the error should NOT be retried.
 */
function isNonRetryableClientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Match "HTTP 4xx" patterns but exclude 429 (Too Many Requests)
  const httpStatusMatch = message.match(/HTTP\s+(\d{3})/);
  if (httpStatusMatch) {
    const status = parseInt(httpStatusMatch[1], 10);
    return status >= 400 && status < 500 && status !== 429;
  }
  return false;
}

/**
 * Retry function with exponential backoff.
 * Does not retry 4xx client errors (except 429 Too Many Requests).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry 4xx client errors (except 429) — they won't succeed on retry
      if (isNonRetryableClientError(error)) {
        throw error;
      }

      if (attempt < maxAttempts - 1) {
        const delay = getBackoffDelay(attempt, baseDelay);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Check if online
 */
export function isOnline(): boolean {
  return navigator.onLine;
}

/**
 * Generate unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}
