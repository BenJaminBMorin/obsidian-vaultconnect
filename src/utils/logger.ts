/**
 * Logging utility with configurable log levels
 */

export enum LogLevel {
  NONE = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
  TRACE = 5
}

export interface LoggerConfig {
  level: LogLevel
  prefix: string
  enableTimestamps: boolean
}

export class Logger {
  private config: LoggerConfig

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: config.level ?? LogLevel.INFO,
      prefix: config.prefix ?? '[VaultSync]',
      enableTimestamps: config.enableTimestamps ?? true
    }
  }

  /**
   * Update logger configuration
   */
  setLevel(level: LogLevel): void {
    this.config.level = level
  }

  setPrefix(prefix: string): void {
    this.config.prefix = prefix
  }

  setEnableTimestamps(enable: boolean): void {
    this.config.enableTimestamps = enable
  }

  /**
   * Format log message with prefix and timestamp
   */
  private format(level: string, ...args: unknown[]): unknown[] {
    const parts: unknown[] = []

    if (this.config.enableTimestamps) {
      const timestamp = new Date().toISOString().split('T')[1].slice(0, -1)
      parts.push(`[${timestamp}]`)
    }

    parts.push(`${this.config.prefix}[${level}]`)
    parts.push(...args)

    return parts
  }

  /**
   * Log error messages (always shown unless NONE)
   */
  error(...args: unknown[]): void {
    if (this.config.level >= LogLevel.ERROR) {
      console.error(...this.format('ERROR', ...args))
    }
  }

  /**
   * Log warning messages
   */
  warn(...args: unknown[]): void {
    if (this.config.level >= LogLevel.WARN) {
      console.warn(...this.format('WARN', ...args))
    }
  }

  /**
   * Log info messages (default level)
   */
  info(...args: unknown[]): void {
    if (this.config.level >= LogLevel.INFO) {
      console.debug(...this.format('INFO', ...args))
    }
  }

  /**
   * Log debug messages (verbose)
   */
  debug(...args: unknown[]): void {
    if (this.config.level >= LogLevel.DEBUG) {
      console.debug(...this.format('DEBUG', ...args))
    }
  }

  /**
   * Log trace messages (very verbose)
   */
  trace(...args: unknown[]): void {
    if (this.config.level >= LogLevel.TRACE) {
      console.debug(...this.format('TRACE', ...args))
    }
  }

  /**
   * Log HTTP requests (special case for 404s)
   */
  http(method: string, url: string, status: number, ...args: unknown[]): void {
    // 404s are expected for file existence checks - only log at DEBUG level
    if (status === 404) {
      this.debug(`${method} ${url} ${status}`, ...args)
    } else if (status >= 400) {
      this.warn(`${method} ${url} ${status}`, ...args)
    } else {
      this.trace(`${method} ${url} ${status}`, ...args)
    }
  }

  /**
   * Create a child logger with a different prefix
   */
  child(prefix: string): Logger {
    return new Logger({
      ...this.config,
      prefix: `${this.config.prefix}${prefix}`
    })
  }
}

// Create default logger instance
export const logger = new Logger()

// Export log level names for settings UI
export const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.NONE]: 'None',
  [LogLevel.ERROR]: 'Error',
  [LogLevel.WARN]: 'Warning',
  [LogLevel.INFO]: 'Info',
  [LogLevel.DEBUG]: 'Debug',
  [LogLevel.TRACE]: 'Trace'
}

export const LOG_LEVEL_DESCRIPTIONS: Record<LogLevel, string> = {
  [LogLevel.NONE]: 'No logging',
  [LogLevel.ERROR]: 'Only errors',
  [LogLevel.WARN]: 'Errors and warnings',
  [LogLevel.INFO]: 'Normal operation (recommended)',
  [LogLevel.DEBUG]: 'Detailed debugging info',
  [LogLevel.TRACE]: 'Very verbose (all requests)'
}
