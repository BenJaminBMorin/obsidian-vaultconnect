/**
 * Types and interfaces for the Initial Sync Setup feature
 * 
 * This module defines the data structures used during first-time vault connection
 * to handle existing files on both local and remote sides.
 */

/**
 * Enum representing the three sync options available during initial setup
 */
export enum InitialSyncOption {
  /** Clear local files and download everything from remote */
  START_FRESH = 'start-fresh',
  /** Upload all local files to remote, overwriting conflicts */
  UPLOAD_LOCAL = 'upload-local',
  /** Intelligently merge files from both locations */
  SMART_MERGE = 'smart-merge'
}

/**
 * State tracking for initial sync completion per vault
 * Stored in plugin settings to remember which vaults have completed initial sync
 */
export interface InitialSyncState {
  /** The VaultSync vault ID */
  vaultId: string;
  /** Whether initial sync has been completed for this vault */
  completed: boolean;
  /** Timestamp when initial sync was completed (null if not completed) */
  completedAt: Date | null;
  /** The sync option chosen by the user (null if not completed) */
  chosenOption: InitialSyncOption | null;
  /** File counts at the time of completion */
  fileCounts: {
    /** Number of files that existed only locally */
    localOnly: number;
    /** Number of files that existed only remotely */
    remoteOnly: number;
    /** Number of files that existed in both locations */
    both: number;
    /** Number of files excluded from sync */
    excluded: number;
  };
}

/**
 * Result of analyzing file differences between local and remote vaults
 * Used to present information to the user and execute sync operations
 */
export interface FileAnalysis {
  /** Paths of files that exist only in the local vault */
  localFiles: string[];
  /** Paths of files that exist only in the remote vault */
  remoteFiles: string[];
  /** Paths of files that exist in both local and remote vaults */
  commonFiles: string[];
  /** Paths of files excluded from sync (e.g., .obsidian, .trash) */
  excludedFiles: string[];
  /** Total count of files in local vault (including excluded) */
  totalLocal: number;
  /** Total count of files in remote vault */
  totalRemote: number;
}

/**
 * Progress information for sync operations
 * Used to update the progress modal during file operations
 */
export interface ProgressInfo {
  /** Current operation being performed */
  operation: 'analyzing' | 'deleting' | 'uploading' | 'downloading' | 'merging';
  /** Path of the file currently being processed */
  currentFile: string;
  /** Number of files completed so far */
  completed: number;
  /** Total number of files to process */
  total: number;
  /** Progress percentage (0-100) */
  percentage: number;
  /** Estimated time remaining in seconds (optional) */
  estimatedTimeRemaining?: number;
}

/**
 * Error types that can occur during initial sync
 * Used for error handling and recovery strategies
 */
export enum InitialSyncError {
  /** Network connection error (recoverable with retry) */
  NETWORK_ERROR = 'NETWORK_ERROR',
  /** File system permission error (not recoverable) */
  PERMISSION_ERROR = 'PERMISSION_ERROR',
  /** Storage quota exceeded (may be recoverable) */
  STORAGE_QUOTA_ERROR = 'STORAGE_QUOTA_ERROR',
  /** Error during file operation (may be recoverable) */
  FILE_OPERATION_ERROR = 'FILE_OPERATION_ERROR',
  /** User cancelled the operation */
  USER_CANCELLED = 'USER_CANCELLED',
  /** File analysis took too long */
  ANALYSIS_TIMEOUT = 'ANALYSIS_TIMEOUT'
}

/**
 * Detailed error information for initial sync errors
 */
export interface InitialSyncErrorInfo {
  /** Type of error that occurred */
  type: InitialSyncError;
  /** Human-readable error message */
  message: string;
  /** Additional error details (optional) */
  details?: unknown;
  /** Whether the error is recoverable (can retry) */
  recoverable: boolean;
}
