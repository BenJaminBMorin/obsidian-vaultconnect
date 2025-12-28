/**
 * Security Utilities
 * Provides security-related helper functions
 */

/**
 * Sanitize HTML content to prevent XSS
 */
export function sanitizeHTML(content: string): string {
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Validate file path to prevent directory traversal
 */
export function validateFilePath(path: string): boolean {
  // Prevent directory traversal
  if (path.includes('..')) return false;
  
  // Prevent absolute paths
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  
  // Prevent Windows drive letters
  if (/^[a-zA-Z]:/.test(path)) return false;
  
  // Normalize and check again
  const normalized = path.replace(/\\/g, '/');
  if (normalized.includes('../') || normalized.startsWith('../')) return false;
  
  return true;
}

/**
 * Sanitize file name to prevent issues
 */
export function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[<>:"|?*]/g, '') // Remove invalid characters
    .replace(/\.\./g, '') // Remove directory traversal
    .replace(/^\.+/, '') // Remove leading dots
    .trim();
}

/**
 * Validate URL to prevent SSRF
 */
export function validateURL(url: string, allowedDomains: string[]): boolean {
  try {
    const parsed = new URL(url);
    
    // Only allow HTTPS
    if (parsed.protocol !== 'https:') return false;
    
    // Check if domain is in whitelist
    const hostname = parsed.hostname;
    return allowedDomains.some(domain => 
      hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

/**
 * Mask sensitive data for logging
 */
export function maskSensitiveData(data: string, visibleChars: number = 4): string {
  if (data.length <= visibleChars) {
    return '*'.repeat(data.length);
  }
  
  const visible = data.slice(-visibleChars);
  const masked = '*'.repeat(data.length - visibleChars);
  return masked + visible;
}

/**
 * Validate API key format
 */
export function validateAPIKey(apiKey: string): boolean {
  // API key should be alphanumeric and at least 32 characters
  if (apiKey.length < 32) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(apiKey)) return false;
  
  return true;
}

/**
 * Generate secure random string
 */
export function generateSecureRandom(length: number = 32): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  
  return result === 0;
}

/**
 * Validate content size to prevent DoS
 */
export function validateContentSize(content: string, maxSizeBytes: number = 10 * 1024 * 1024): boolean {
  const sizeBytes = new Blob([content]).size;
  return sizeBytes <= maxSizeBytes;
}

/**
 * Remove sensitive data from error messages
 */
export function sanitizeError(error: Error): Error {
  const sanitized = new Error(error.message);
  
  // Remove sensitive patterns from message
  sanitized.message = error.message
    .replace(/api[_-]?key[=:]\s*[a-zA-Z0-9_-]+/gi, 'api_key=***')
    .replace(/token[=:]\s*[a-zA-Z0-9_-]+/gi, 'token=***')
    .replace(/password[=:]\s*[^\s]+/gi, 'password=***')
    .replace(/bearer\s+[a-zA-Z0-9_-]+/gi, 'bearer ***');
  
  // Don't include stack trace in production
  if (process.env.NODE_ENV === 'production') {
    delete sanitized.stack;
  }
  
  return sanitized;
}

/**
 * Validate JSON to prevent prototype pollution
 */
export function safeJSONParse<T>(json: string): T | null {
  try {
    const parsed = JSON.parse(json);
    
    // Check for prototype pollution attempts
    if (parsed.__proto__ || parsed.constructor || parsed.prototype) {
      console.warn('Potential prototype pollution detected');
      return null;
    }
    
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * Create safe object without prototype
 */
export function createSafeObject<T extends object>(obj: T): T {
  return Object.assign(Object.create(null), obj);
}

/**
 * Rate limiter to prevent abuse
 */
export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  
  constructor(
    private maxRequests: number,
    private windowMs: number
  ) {}
  
  /**
   * Check if request is allowed
   */
  isAllowed(key: string): boolean {
    const now = Date.now();
    const requests = this.requests.get(key) || [];
    
    // Remove old requests outside the window
    const validRequests = requests.filter(time => now - time < this.windowMs);
    
    if (validRequests.length >= this.maxRequests) {
      return false;
    }
    
    validRequests.push(now);
    this.requests.set(key, validRequests);
    
    return true;
  }
  
  /**
   * Clear rate limit for a key
   */
  clear(key: string): void {
    this.requests.delete(key);
  }
  
  /**
   * Clear all rate limits
   */
  clearAll(): void {
    this.requests.clear();
  }
}

/**
 * Input validator with common patterns
 */
export class InputValidator {
  /**
   * Validate email format
   */
  static isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
  
  /**
   * Validate URL format
   */
  static isValidURL(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Validate alphanumeric string
   */
  static isAlphanumeric(str: string): boolean {
    return /^[a-zA-Z0-9]+$/.test(str);
  }
  
  /**
   * Validate string length
   */
  static isValidLength(str: string, min: number, max: number): boolean {
    return str.length >= min && str.length <= max;
  }
  
  /**
   * Validate against whitelist
   */
  static isInWhitelist(value: string, whitelist: string[]): boolean {
    return whitelist.includes(value);
  }
}

/**
 * Content Security Policy helper
 */
export class CSPHelper {
  /**
   * Generate nonce for inline scripts
   */
  static generateNonce(): string {
    return generateSecureRandom(16);
  }
  
  /**
   * Create CSP header value
   */
  static createCSP(options: {
    scriptSrc?: string[];
    styleSrc?: string[];
    imgSrc?: string[];
    connectSrc?: string[];
  }): string {
    const directives: string[] = [];
    
    if (options.scriptSrc) {
      directives.push(`script-src ${options.scriptSrc.join(' ')}`);
    }
    
    if (options.styleSrc) {
      directives.push(`style-src ${options.styleSrc.join(' ')}`);
    }
    
    if (options.imgSrc) {
      directives.push(`img-src ${options.imgSrc.join(' ')}`);
    }
    
    if (options.connectSrc) {
      directives.push(`connect-src ${options.connectSrc.join(' ')}`);
    }
    
    return directives.join('; ');
  }
}

// Note: SecureStorage has been removed as it used localStorage directly.
// Use StorageManager from core/StorageManager.ts for plugin data persistence.
