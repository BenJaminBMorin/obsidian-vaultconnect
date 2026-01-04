/**
 * Error Handling System
 * Provides error classification, user-friendly messages, logging, and recovery mechanisms
 */

/**
 * Error types for classification
 */
export enum ErrorType {
  NETWORK_ERROR = 'network_error',
  AUTH_ERROR = 'auth_error',
  SYNC_ERROR = 'sync_error',
  CONFLICT_ERROR = 'conflict_error',
  STORAGE_ERROR = 'storage_error',
  VALIDATION_ERROR = 'validation_error',
  WEBSOCKET_ERROR = 'websocket_error',
  COLLABORATION_ERROR = 'collaboration_error',
  FILE_ERROR = 'file_error',
  UNKNOWN_ERROR = 'unknown_error'
}

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

/**
 * Plugin error interface
 */
export interface PluginError {
  type: ErrorType;
  message: string;
  userMessage: string;
  details?: any;
  originalError?: Error;
  recoverable: boolean;
  retryable: boolean;
  severity: ErrorSeverity;
  timestamp: Date;
  context?: Record<string, any>;
}

/**
 * Error recovery strategy
 */
export interface ErrorRecoveryStrategy {
  canRecover: (error: PluginError) => boolean;
  recover: (error: PluginError) => Promise<boolean>;
  description: string;
}

/**
 * Base error class for VaultSync plugin
 */
export class VaultSyncError extends Error {
  public readonly type: ErrorType;
  public readonly userMessage: string;
  public readonly recoverable: boolean;
  public readonly retryable: boolean;
  public readonly severity: ErrorSeverity;
  public readonly timestamp: Date;
  public readonly context?: Record<string, any>;
  public readonly originalError?: Error;

  constructor(
    type: ErrorType,
    message: string,
    userMessage: string,
    options: {
      recoverable?: boolean;
      retryable?: boolean;
      severity?: ErrorSeverity;
      context?: Record<string, any>;
      originalError?: Error;
    } = {}
  ) {
    super(message);
    this.name = 'VaultSyncError';
    this.type = type;
    this.userMessage = userMessage;
    this.recoverable = options.recoverable ?? false;
    this.retryable = options.retryable ?? false;
    this.severity = options.severity ?? ErrorSeverity.MEDIUM;
    this.timestamp = new Date();
    this.context = options.context;
    this.originalError = options.originalError;

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, VaultSyncError);
    }
  }

  toPluginError(): PluginError {
    return {
      type: this.type,
      message: this.message,
      userMessage: this.userMessage,
      details: this.context,
      originalError: this.originalError,
      recoverable: this.recoverable,
      retryable: this.retryable,
      severity: this.severity,
      timestamp: this.timestamp,
      context: this.context
    };
  }
}

/**
 * Network error
 */
export class NetworkError extends VaultSyncError {
  constructor(message: string, originalError?: Error, context?: Record<string, any>) {
    super(
      ErrorType.NETWORK_ERROR,
      message,
      'Network connection issue. Please check your internet connection.',
      {
        recoverable: true,
        retryable: true,
        severity: ErrorSeverity.MEDIUM,
        context,
        originalError
      }
    );
    this.name = 'NetworkError';
  }
}

/**
 * Authentication error
 */
export class AuthenticationError extends VaultSyncError {
  constructor(message: string, originalError?: Error, context?: Record<string, any>) {
    super(
      ErrorType.AUTH_ERROR,
      message,
      'Authentication failed. Please log in again.',
      {
        recoverable: true,
        retryable: false,
        severity: ErrorSeverity.HIGH,
        context,
        originalError
      }
    );
    this.name = 'AuthenticationError';
  }
}

/**
 * Sync error
 */
export class SyncError extends VaultSyncError {
  constructor(message: string, userMessage: string, originalError?: Error, context?: Record<string, any>) {
    super(
      ErrorType.SYNC_ERROR,
      message,
      userMessage,
      {
        recoverable: true,
        retryable: true,
        severity: ErrorSeverity.MEDIUM,
        context,
        originalError
      }
    );
    this.name = 'SyncError';
  }
}

/**
 * Conflict error
 */
export class ConflictError extends VaultSyncError {
  constructor(message: string, originalError?: Error, context?: Record<string, any>) {
    super(
      ErrorType.CONFLICT_ERROR,
      message,
      'File conflict detected. Please resolve the conflict manually.',
      {
        recoverable: true,
        retryable: false,
        severity: ErrorSeverity.MEDIUM,
        context,
        originalError
      }
    );
    this.name = 'ConflictError';
  }
}

/**
 * Storage error
 */
export class StorageError extends VaultSyncError {
  constructor(message: string, originalError?: Error, context?: Record<string, any>) {
    super(
      ErrorType.STORAGE_ERROR,
      message,
      'Failed to access local storage. Please check your disk space.',
      {
        recoverable: true,
        retryable: true,
        severity: ErrorSeverity.HIGH,
        context,
        originalError
      }
    );
    this.name = 'StorageError';
  }
}

/**
 * Validation error
 */
export class ValidationError extends VaultSyncError {
  constructor(message: string, userMessage: string, context?: Record<string, any>) {
    super(
      ErrorType.VALIDATION_ERROR,
      message,
      userMessage,
      {
        recoverable: false,
        retryable: false,
        severity: ErrorSeverity.LOW,
        context
      }
    );
    this.name = 'ValidationError';
  }
}

/**
 * WebSocket error
 */
export class WebSocketError extends VaultSyncError {
  constructor(message: string, originalError?: Error, context?: Record<string, any>) {
    super(
      ErrorType.WEBSOCKET_ERROR,
      message,
      'Real-time connection issue. Attempting to reconnect...',
      {
        recoverable: true,
        retryable: true,
        severity: ErrorSeverity.MEDIUM,
        context,
        originalError
      }
    );
    this.name = 'WebSocketError';
  }
}

/**
 * Collaboration error
 */
export class CollaborationError extends VaultSyncError {
  constructor(message: string, userMessage: string, originalError?: Error, context?: Record<string, any>) {
    super(
      ErrorType.COLLABORATION_ERROR,
      message,
      userMessage,
      {
        recoverable: true,
        retryable: true,
        severity: ErrorSeverity.MEDIUM,
        context,
        originalError
      }
    );
    this.name = 'CollaborationError';
  }
}

/**
 * File error
 */
export class FileError extends VaultSyncError {
  constructor(message: string, userMessage: string, originalError?: Error, context?: Record<string, any>) {
    super(
      ErrorType.FILE_ERROR,
      message,
      userMessage,
      {
        recoverable: true,
        retryable: true,
        severity: ErrorSeverity.MEDIUM,
        context,
        originalError
      }
    );
    this.name = 'FileError';
  }
}

/**
 * Error classifier - converts generic errors to typed errors
 */
export class ErrorClassifier {
  /**
   * Classify an error
   */
  static classify(error: any, context?: Record<string, any>): VaultSyncError {
    // Already a VaultSyncError
    if (error instanceof VaultSyncError) {
      return error;
    }

    const message = this.extractMessage(error);
    const lowerMessage = message.toLowerCase();

    // Network errors
    if (
      lowerMessage.includes('network') ||
      lowerMessage.includes('fetch') ||
      lowerMessage.includes('connection') ||
      lowerMessage.includes('timeout') ||
      lowerMessage.includes('econnrefused') ||
      lowerMessage.includes('enotfound')
    ) {
      return new NetworkError(message, error, context);
    }

    // Authentication errors
    if (
      lowerMessage.includes('auth') ||
      lowerMessage.includes('unauthorized') ||
      lowerMessage.includes('401') ||
      lowerMessage.includes('403') ||
      lowerMessage.includes('token') ||
      lowerMessage.includes('api key')
    ) {
      return new AuthenticationError(message, error, context);
    }

    // Conflict errors
    if (
      lowerMessage.includes('conflict') ||
      lowerMessage.includes('409')
    ) {
      return new ConflictError(message, error, context);
    }

    // Storage errors
    if (
      lowerMessage.includes('storage') ||
      lowerMessage.includes('disk') ||
      lowerMessage.includes('enospc') ||
      lowerMessage.includes('quota')
    ) {
      return new StorageError(message, error, context);
    }

    // WebSocket errors
    if (
      lowerMessage.includes('websocket') ||
      lowerMessage.includes('ws://') ||
      lowerMessage.includes('wss://')
    ) {
      return new WebSocketError(message, error, context);
    }

    // File errors
    if (
      lowerMessage.includes('file') ||
      lowerMessage.includes('enoent') ||
      lowerMessage.includes('eacces')
    ) {
      return new FileError(
        message,
        'File operation failed. Please check file permissions.',
        error,
        context
      );
    }

    // Default to generic sync error
    return new SyncError(
      message,
      'An unexpected error occurred. Please try again.',
      error,
      context
    );
  }

  /**
   * Extract error message
   */
  private static extractMessage(error: any): string {
    if (typeof error === 'string') {
      return error;
    }

    if (error instanceof Error) {
      return error.message;
    }

    if (error?.message) {
      return error.message;
    }

    if (error?.error?.message) {
      return error.error.message;
    }

    return 'Unknown error occurred';
  }
}

/**
 * Error logger
 */
export class ErrorLogger {
  private static logs: PluginError[] = [];
  private static maxLogs = 100;

  /**
   * Log an error
   */
  static log(error: VaultSyncError | PluginError): void {
    const pluginError = error instanceof VaultSyncError ? error.toPluginError() : error;

    // Add to logs
    this.logs.unshift(pluginError);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
    }

    // Console logging based on severity
    const logMethod = this.getLogMethod(pluginError.severity);
    const logMessage = this.formatLogMessage(pluginError);

    logMethod(logMessage);

    // Log stack trace for high severity errors
    if (
      pluginError.severity === ErrorSeverity.HIGH ||
      pluginError.severity === ErrorSeverity.CRITICAL
    ) {
      if (pluginError.originalError?.stack) {
        console.error('Stack trace:', pluginError.originalError.stack);
      }
    }

    // Log context if available
    if (pluginError.context) {
      console.debug('Error context:', pluginError.context);
    }
  }

  /**
   * Get all logged errors
   */
  static getLogs(): PluginError[] {
    return [...this.logs];
  }

  /**
   * Get logs by type
   */
  static getLogsByType(type: ErrorType): PluginError[] {
    return this.logs.filter(log => log.type === type);
  }

  /**
   * Get logs by severity
   */
  static getLogsBySeverity(severity: ErrorSeverity): PluginError[] {
    return this.logs.filter(log => log.severity === severity);
  }

  /**
   * Clear logs
   */
  static clearLogs(): void {
    this.logs = [];
  }

  /**
   * Get log method based on severity
   */
  private static getLogMethod(severity: ErrorSeverity): (...args: any[]) => void {
    switch (severity) {
      case ErrorSeverity.CRITICAL:
      case ErrorSeverity.HIGH:
        return console.error;
      case ErrorSeverity.MEDIUM:
        return console.warn;
      case ErrorSeverity.LOW:
        return console.debug;
      default:
        return console.debug;
    }
  }

  /**
   * Format log message
   */
  private static formatLogMessage(error: PluginError): string {
    const timestamp = error.timestamp.toISOString();
    const type = error.type.toUpperCase();
    const severity = error.severity.toUpperCase();

    return `[${timestamp}] [${severity}] [${type}] ${error.message}`;
  }
}

/**
 * Error recovery manager
 */
export class ErrorRecoveryManager {
  private strategies: Map<ErrorType, ErrorRecoveryStrategy[]> = new Map();

  /**
   * Register a recovery strategy
   */
  registerStrategy(type: ErrorType, strategy: ErrorRecoveryStrategy): void {
    if (!this.strategies.has(type)) {
      this.strategies.set(type, []);
    }
    this.strategies.get(type)!.push(strategy);
  }

  /**
   * Attempt to recover from an error
   */
  async attemptRecovery(error: VaultSyncError): Promise<boolean> {
    if (!error.recoverable) {
      console.debug(`Error is not recoverable: ${error.type}`);
      return false;
    }

    const strategies = this.strategies.get(error.type) || [];
    
    for (const strategy of strategies) {
      if (strategy.canRecover(error.toPluginError())) {
        console.debug(`Attempting recovery with strategy: ${strategy.description}`);
        
        try {
          const recovered = await strategy.recover(error.toPluginError());
          if (recovered) {
            console.debug(`Successfully recovered from error: ${error.type}`);
            return true;
          }
        } catch (recoveryError) {
          console.error(`Recovery strategy failed:`, recoveryError);
        }
      }
    }

    console.debug(`No recovery strategy succeeded for error: ${error.type}`);
    return false;
  }

  /**
   * Get available strategies for an error type
   */
  getStrategies(type: ErrorType): ErrorRecoveryStrategy[] {
    return this.strategies.get(type) || [];
  }
}

/**
 * Retry helper with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 1000,
  maxDelayMs: number = 10000
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries) {
        const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
        console.debug(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: any): boolean {
  if (error instanceof VaultSyncError) {
    return error.retryable;
  }

  const classified = ErrorClassifier.classify(error);
  return classified.retryable;
}

/**
 * Check if error is recoverable
 */
export function isRecoverableError(error: any): boolean {
  if (error instanceof VaultSyncError) {
    return error.recoverable;
  }

  const classified = ErrorClassifier.classify(error);
  return classified.recoverable;
}

/**
 * Get user-friendly error message
 */
export function getUserMessage(error: any): string {
  if (error instanceof VaultSyncError) {
    return error.userMessage;
  }

  const classified = ErrorClassifier.classify(error);
  return classified.userMessage;
}
