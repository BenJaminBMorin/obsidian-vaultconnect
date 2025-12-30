import { EventBus, EVENTS } from '../core/EventBus';
import { StorageManager } from '../core/StorageManager';
import { SyncResult } from './SyncService';

/**
 * Sync log entry type
 */
export enum SyncLogType {
  SYNC_STARTED = 'sync_started',
  SYNC_COMPLETED = 'sync_completed',
  SYNC_ERROR = 'sync_error',
  FILE_UPLOADED = 'file_uploaded',
  FILE_DOWNLOADED = 'file_downloaded',
  FILE_DELETED = 'file_deleted',
  CONFLICT_DETECTED = 'conflict_detected',
  CONFLICT_RESOLVED = 'conflict_resolved',
  CONNECTION_CHANGED = 'connection_changed',
  CONNECTION_ERROR = 'connection_error'
}

/**
 * Sync log entry
 */
export interface SyncLogEntry {
  id: string;
  timestamp: Date;
  type: SyncLogType;
  message: string;
  details?: any;
  filePath?: string;
  error?: string;
}

/**
 * Sync statistics
 */
export interface SyncStatistics {
  totalSyncs: number;
  successfulSyncs: number;
  failedSyncs: number;
  filesUploaded: number;
  filesDownloaded: number;
  filesDeleted: number;
  conflictsDetected: number;
  conflictsResolved: number;
  lastSyncTime: Date | null;
  averageSyncDuration: number;
}

/**
 * Sync log filter
 */
export interface SyncLogFilter {
  types?: SyncLogType[];
  filePath?: string;
  startDate?: Date;
  endDate?: Date;
  searchQuery?: string;
}

/**
 * Sync log service
 * Tracks and stores sync activity
 */
export class SyncLogService {
  private eventBus: EventBus;
  private storage: StorageManager;
  private logs: SyncLogEntry[] = [];
  private maxLogEntries: number = 1000;
  private statistics: SyncStatistics = {
    totalSyncs: 0,
    successfulSyncs: 0,
    failedSyncs: 0,
    filesUploaded: 0,
    filesDownloaded: 0,
    filesDeleted: 0,
    conflictsDetected: 0,
    conflictsResolved: 0,
    lastSyncTime: null,
    averageSyncDuration: 0
  };
  private syncDurations: number[] = [];

  constructor(eventBus: EventBus, storage: StorageManager) {
    this.eventBus = eventBus;
    this.storage = storage;
    
    this.setupEventListeners();
  }

  /**
   * Initialize sync log service
   */
  async initialize(): Promise<void> {
    // Load logs from storage
    const storedLogs = await this.storage.get<SyncLogEntry[]>('sync_logs');
    if (storedLogs) {
      this.logs = storedLogs.map(log => ({
        ...log,
        timestamp: new Date(log.timestamp)
      }));
    }

    // Load statistics from storage
    const storedStats = await this.storage.get<SyncStatistics>('sync_statistics');
    if (storedStats) {
      this.statistics = {
        ...storedStats,
        lastSyncTime: storedStats.lastSyncTime ? new Date(storedStats.lastSyncTime) : null
      };
    }

    console.debug('SyncLogService initialized with', this.logs.length, 'log entries');
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Sync events
    this.eventBus.on(EVENTS.SYNC_STARTED, () => {
      this.addLog(SyncLogType.SYNC_STARTED, 'Sync started');
    });

    this.eventBus.on(EVENTS.SYNC_COMPLETED, (result: SyncResult) => {
      this.addLog(SyncLogType.SYNC_COMPLETED, 'Sync completed', result);
      this.updateStatistics(result);
    });

    this.eventBus.on(EVENTS.SYNC_ERROR, (error: any) => {
      this.addLog(
        SyncLogType.SYNC_ERROR,
        'Sync error',
        error,
        error.path,
        error.error || error.message
      );
      this.statistics.failedSyncs++;
      this.saveStatistics();
    });

    // File events
    this.eventBus.on(EVENTS.FILE_SYNCED, (data: any) => {
      const { path, action } = data;
      
      switch (action) {
        case 'upload':
        case 'create':
        case 'update':
          this.addLog(SyncLogType.FILE_UPLOADED, `File uploaded: ${path}`, data, path);
          this.statistics.filesUploaded++;
          break;
        case 'download':
          this.addLog(SyncLogType.FILE_DOWNLOADED, `File downloaded: ${path}`, data, path);
          this.statistics.filesDownloaded++;
          break;
        case 'delete':
          this.addLog(SyncLogType.FILE_DELETED, `File deleted: ${path}`, data, path);
          this.statistics.filesDeleted++;
          break;
      }
      
      this.saveStatistics();
    });

    // Conflict events
    this.eventBus.on(EVENTS.CONFLICT_DETECTED, (data: any) => {
      this.addLog(
        SyncLogType.CONFLICT_DETECTED,
        `Conflict detected: ${data.path}`,
        data,
        data.path
      );
      this.statistics.conflictsDetected++;
      this.saveStatistics();
    });

    this.eventBus.on(EVENTS.CONFLICT_RESOLVED, (data: any) => {
      this.addLog(
        SyncLogType.CONFLICT_RESOLVED,
        `Conflict resolved: ${data.path}`,
        data,
        data.path
      );
      this.statistics.conflictsResolved++;
      this.saveStatistics();
    });

    // Connection events
    this.eventBus.on(EVENTS.CONNECTION_CHANGED, (connected: boolean) => {
      this.addLog(
        SyncLogType.CONNECTION_CHANGED,
        connected ? 'Connected to VaultSync' : 'Disconnected from VaultSync',
        { connected }
      );
    });

    this.eventBus.on(EVENTS.CONNECTION_ERROR, (error: any) => {
      this.addLog(
        SyncLogType.CONNECTION_ERROR,
        'Connection error',
        error,
        undefined,
        error.message
      );
    });
  }

  /**
   * Add log entry
   */
  private addLog(
    type: SyncLogType,
    message: string,
    details?: any,
    filePath?: string,
    error?: string
  ): void {
    const entry: SyncLogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      timestamp: new Date(),
      type,
      message,
      details,
      filePath,
      error
    };

    this.logs.unshift(entry); // Add to beginning

    // Trim logs if exceeding max
    if (this.logs.length > this.maxLogEntries) {
      this.logs = this.logs.slice(0, this.maxLogEntries);
    }

    // Save to storage (debounced)
    this.saveLogs();
  }

  /**
   * Update statistics from sync result
   */
  private updateStatistics(result: SyncResult): void {
    this.statistics.totalSyncs++;
    
    if (result.success) {
      this.statistics.successfulSyncs++;
    } else {
      this.statistics.failedSyncs++;
    }

    this.statistics.filesUploaded += result.filesUploaded || 0;
    this.statistics.filesDownloaded += result.filesDownloaded || 0;
    this.statistics.filesDeleted += result.filesDeleted || 0;
    this.statistics.lastSyncTime = new Date();

    // Track sync duration
    if (result.duration) {
      this.syncDurations.push(result.duration);
      
      // Keep only last 100 durations
      if (this.syncDurations.length > 100) {
        this.syncDurations.shift();
      }

      // Calculate average
      const sum = this.syncDurations.reduce((a, b) => a + b, 0);
      this.statistics.averageSyncDuration = Math.round(sum / this.syncDurations.length);
    }

    this.saveStatistics();
  }

  /**
   * Get all logs
   */
  getLogs(): SyncLogEntry[] {
    return [...this.logs];
  }

  /**
   * Get filtered logs
   */
  getFilteredLogs(filter: SyncLogFilter): SyncLogEntry[] {
    let filtered = [...this.logs];

    // Filter by type
    if (filter.types && filter.types.length > 0) {
      filtered = filtered.filter(log => filter.types!.includes(log.type));
    }

    // Filter by file path
    if (filter.filePath) {
      filtered = filtered.filter(log => 
        log.filePath && log.filePath.includes(filter.filePath!)
      );
    }

    // Filter by date range
    if (filter.startDate) {
      filtered = filtered.filter(log => log.timestamp >= filter.startDate!);
    }
    if (filter.endDate) {
      filtered = filtered.filter(log => log.timestamp <= filter.endDate!);
    }

    // Filter by search query
    if (filter.searchQuery) {
      const query = filter.searchQuery.toLowerCase();
      filtered = filtered.filter(log =>
        log.message.toLowerCase().includes(query) ||
        (log.filePath && log.filePath.toLowerCase().includes(query)) ||
        (log.error && log.error.toLowerCase().includes(query))
      );
    }

    return filtered;
  }

  /**
   * Get recent logs
   */
  getRecentLogs(count: number = 50): SyncLogEntry[] {
    return this.logs.slice(0, count);
  }

  /**
   * Get logs by type
   */
  getLogsByType(type: SyncLogType): SyncLogEntry[] {
    return this.logs.filter(log => log.type === type);
  }

  /**
   * Get logs by file path
   */
  getLogsByFilePath(filePath: string): SyncLogEntry[] {
    return this.logs.filter(log => log.filePath === filePath);
  }

  /**
   * Get statistics
   */
  getStatistics(): SyncStatistics {
    return { ...this.statistics };
  }

  /**
   * Clear logs
   */
  async clearLogs(): Promise<void> {
    this.logs = [];
    await this.saveLogs();
  }

  /**
   * Clear statistics
   */
  async clearStatistics(): Promise<void> {
    this.statistics = {
      totalSyncs: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      filesUploaded: 0,
      filesDownloaded: 0,
      filesDeleted: 0,
      conflictsDetected: 0,
      conflictsResolved: 0,
      lastSyncTime: null,
      averageSyncDuration: 0
    };
    this.syncDurations = [];
    await this.saveStatistics();
  }

  /**
   * Save logs to storage
   */
  private async saveLogs(): Promise<void> {
    try {
      await this.storage.set('sync_logs', this.logs);
    } catch (error) {
      console.error('Error saving sync logs:', error);
    }
  }

  /**
   * Save statistics to storage
   */
  private async saveStatistics(): Promise<void> {
    try {
      await this.storage.set('sync_statistics', this.statistics);
    } catch (error) {
      console.error('Error saving sync statistics:', error);
    }
  }

  /**
   * Export logs as JSON
   */
  exportLogs(): string {
    return JSON.stringify(this.logs, null, 2);
  }

  /**
   * Export statistics as JSON
   */
  exportStatistics(): string {
    return JSON.stringify(this.statistics, null, 2);
  }
}
