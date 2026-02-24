// Core Types for VaultSync Plugin

// Export initial sync types
export * from './initial-sync.types';

export interface PluginSettings {
  // Server discovery
  serverUrl: string; // User-facing URL (web UI or API base)

  // Authentication
  apiKey: string | null;
  apiKeyExpires: Date | null;

  // Vault selection
  selectedVaultId: string | null;
  vaultId: string; // Legacy alias for selectedVaultId (used by main.ts connect logic)

  // Sync settings
  syncMode: SyncMode;
  autoSync: boolean;
  syncInterval: number; // seconds

  // Selective sync
  includedFolders: string[];
  excludedFolders: string[];

  // Collaboration
  collaborationEnabled: boolean;
  showPresence: boolean;
  showCursors: boolean;
  showTypingIndicators: boolean;

  // Notifications
  notifyOnSync: boolean;
  notifyOnConflict: boolean;
  notifyOnCollaboratorJoin: boolean;

  // Performance
  maxConcurrentUploads: number;
  chunkSize: number; // bytes
  cacheEnabled: boolean;

  // Advanced
  apiBaseURL: string;
  wsBaseURL: string;
  apiUrl: string; // Legacy alias for apiBaseURL
  wsUrl: string; // Legacy alias for wsBaseURL
  deviceId: string;
  debugMode: boolean;
  logLevel: number; // LogLevel enum value

  // Initial sync states per vault
  initialSyncStates: Record<string, any>;
}

export enum SyncMode {
  SMART_SYNC = 'smart_sync',
  PULL_ALL = 'pull_all',
  PUSH_ALL = 'push_all',
  MANUAL = 'manual'
}

export interface VaultInfo {
  vault_id: string;
  name: string;
  file_count: number;
  total_size_bytes: number;
  created_at: Date;
  updated_at: Date;
  is_cross_tenant?: boolean;
  permission?: 'read' | 'write' | 'admin';
  owner_tenant_id?: string;
}

export interface FileInfo {
  file_id: string;
  vault_id: string;
  path: string;
  size_bytes: number;
  hash: string;
  created_at: Date;
  updated_at: Date;
  last_editor?: {
    user_id: string;
    user_name: string;
  };
}

export interface FileContent {
  file_id: string;
  path: string;
  content: string;
  hash: string;
  created_at: string;
  updated_at: string;
}

export interface SyncResult {
  success: boolean;
  filesProcessed: number;
  filesUpdated: number;
  filesCreated: number;
  filesDeleted: number;
  conflicts: ConflictInfo[];
  errors: SyncError[];
  duration: number;
}

export interface SyncProgress {
  current: number;
  total: number;
  currentFile: string;
  operation: 'upload' | 'download' | 'check';
}

export interface SyncError {
  file: string;
  error: string;
  recoverable: boolean;
}

export interface ConflictInfo {
  id: string;
  path: string;
  localContent?: string;   // In-memory only — stripped before persistence
  remoteContent?: string;  // In-memory only — stripped before persistence
  localHash?: string;      // Hash at conflict detection time
  remoteHash?: string;     // Hash at conflict detection time
  localModified: Date;
  remoteModified: Date;
  conflictType: ConflictType;
  autoResolvable: boolean;
}

export enum ConflictType {
  CONTENT = 'content',
  DELETION = 'deletion',
  RENAME = 'rename'
}

export enum ResolutionStrategy {
  KEEP_LOCAL = 'keep_local',
  KEEP_REMOTE = 'keep_remote',
  KEEP_BOTH = 'keep_both',
  MERGE_MANUAL = 'merge_manual'
}

export interface ConflictResolution {
  strategy: ResolutionStrategy;
  mergedContent?: string;
}

export interface ActiveUser {
  userId: string;
  userName: string;
  userAvatar?: string;
  status: 'active' | 'away';
  currentFile: string | null;
  lastActivity: Date;
}

export interface PresenceState {
  userId: string;
  vaultId: string;
  status: 'active' | 'away' | 'offline';
  currentFile: string | null;
  lastActivity: Date;
}

export interface AwarenessState {
  user: {
    id: string;
    name: string;
    avatar?: string;
    color: string;
  };
  cursor?: {
    line: number;
    ch: number;
  };
  selection?: {
    from: { line: number; ch: number };
    to: { line: number; ch: number };
  };
  isTyping: boolean;
}

export interface QueuedFile {
  path: string;
  operation: 'create' | 'update' | 'delete';
  content?: string;
  timestamp: Date;
  retries: number;
}

export interface LocalStorage {
  // Sync state
  lastSyncTimestamp: Record<string, Date>; // filePath -> timestamp
  fileHashes: Record<string, string>; // filePath -> hash
  syncQueue: QueuedFile[];
  
  // Conflicts
  conflicts: ConflictInfo[];
  
  // Presence cache
  activeUsers: Record<string, ActiveUser>; // userId -> user
  fileViewers: Record<string, string[]>; // filePath -> userIds
  
  // Collaboration state
  yjsDocuments: Record<string, Uint8Array>; // filePath -> Y.Doc state
  
  // Metadata cache
  vaultCache: VaultInfo | null;
  filesCache: Record<string, FileInfo>; // fileId -> fileInfo
}

// =============================================================================
// Event Data Types
// These types define the data structure for events emitted by the EventBus
// =============================================================================

/**
 * Sync event data (for FILE_SYNCED, SYNC_EVENT)
 */
export interface SyncEventData {
  file_path: string;
  operation: 'create' | 'modify' | 'delete' | 'rename';
  device_id?: string;
  old_path?: string;
  hash?: string;
}

/**
 * File update event data (for FILE_UPDATE)
 */
export interface FileUpdateEventData {
  path: string;
  hash: string;
  size: number;
  updated_at: string;
  device_id?: string;
}

/**
 * Conflict event data (for CONFLICT_DETECTED, CONFLICT_RESOLVED)
 */
export interface ConflictEventData {
  path: string;
  conflictId?: string;
  local_hash?: string;
  remote_hash?: string;
  resolution?: ResolutionStrategy;
}

/**
 * Device event data (for DEVICE_CONNECTED, DEVICE_DISCONNECTED)
 */
export interface DeviceEventData {
  device_id: string;
  device_name?: string;
  connected_at?: string;
}

/**
 * User/Presence event data (for USER_JOINED, USER_LEFT, PRESENCE_UPDATE)
 */
export interface UserEventData {
  userId: string;
  userName: string;
  userAvatar?: string;
  status?: 'active' | 'away' | 'offline';
  currentFile?: string | null;
  vaultId?: string;
}

/**
 * Cursor update event data
 */
export interface CursorEventData {
  userId: string;
  userName: string;
  color: string;
  filePath: string;
  position: {
    line: number;
    ch: number;
  };
}

/**
 * Selection event data
 */
export interface SelectionEventData {
  userId: string;
  userName: string;
  color: string;
  filePath: string;
  from: { line: number; ch: number };
  to: { line: number; ch: number };
}

/**
 * Typing indicator event data
 */
export interface TypingEventData {
  userId: string;
  userName: string;
  filePath: string;
  isTyping: boolean;
}

/**
 * Collaborator event data (for COLLABORATOR_JOINED, COLLABORATOR_LEFT)
 */
export interface CollaboratorEventData {
  userId: string;
  userName: string;
  userAvatar?: string;
  color: string;
  filePath: string;
}

/**
 * Awareness update event data
 */
export interface AwarenessEventData {
  clientId: number;
  userId: string;
  userName: string;
  color: string;
  cursor?: { line: number; ch: number };
  selection?: {
    from: { line: number; ch: number };
    to: { line: number; ch: number };
  };
  isTyping?: boolean;
  filePath?: string;
}

/**
 * Error event data (for SYNC_ERROR, CONNECTION_ERROR, AUTH_ERROR)
 */
export interface ErrorEventData {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
  recoverable?: boolean;
  retryable?: boolean;
}

/**
 * Sync progress event data
 */
export interface SyncProgressEventData {
  current: number;
  total: number;
  currentFile?: string;
  operation?: 'upload' | 'download' | 'check';
  percentage?: number;
}

/**
 * Sync drift event data
 */
export interface SyncDriftEventData {
  driftCount: number;
  files: string[];
}

/**
 * Remote file info (from API responses)
 */
export interface RemoteFileInfo {
  file_id: string;
  path: string;
  hash: string;
  size: number;
  updated_at: string;
  created_at: string;
}
