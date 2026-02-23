import { PluginSettings, SyncMode } from '../types';

export const DEFAULT_SETTINGS: PluginSettings = {
  // Server discovery
  serverUrl: '',

  // Authentication
  apiKey: null,
  apiKeyExpires: null,

  // Vault selection
  selectedVaultId: null,
  vaultId: '',

  // Sync settings
  syncMode: SyncMode.SMART_SYNC,
  autoSync: true,
  syncInterval: 15, // 15 seconds for faster background sync

  // Selective sync
  includedFolders: [],
  excludedFolders: ['.trash'], // Note: vault configDir will be added dynamically during settings load

  // Collaboration
  collaborationEnabled: true,
  showPresence: true,
  showCursors: true,
  showTypingIndicators: true,

  // Notifications
  notifyOnSync: true,
  notifyOnConflict: true,
  notifyOnCollaboratorJoin: true,

  // Performance
  maxConcurrentUploads: 5,
  chunkSize: 1048576, // 1MB
  cacheEnabled: true,

  // Advanced
  apiBaseURL: '',
  wsBaseURL: '',
  apiUrl: '',
  wsUrl: '',
  deviceId: '',
  debugMode: false,
  logLevel: 3, // LogLevel.INFO
  initialSyncStates: {}
};

export const API_ENDPOINTS = {
  // Auth
  AUTH: '/auth',
  
  // Vaults
  VAULTS: '/vaults',
  VAULT: (id: string) => `/vaults/${id}`,
  
  // Files
  FILES: (vaultId: string) => `/vaults/${vaultId}/files`,
  FILE: (vaultId: string, fileId: string) => `/vaults/${vaultId}/files/${fileId}`,
  FILE_CONTENT: (vaultId: string, filePath: string) => `/vaults/${vaultId}/files/path/${encodeURIComponent(filePath)}`,
  
  // Sync
  FILE_HASH: (vaultId: string, filePath: string) => `/vaults/${vaultId}/files/path/${encodeURIComponent(filePath)}/hash`,
  DELTA: (vaultId: string, filePath: string) => `/vaults/${vaultId}/files/path/${encodeURIComponent(filePath)}/delta`,
  
  // Conflicts
  CONFLICTS: (vaultId: string) => `/vaults/${vaultId}/conflicts`,
  CONFLICT: (conflictId: string) => `/conflicts/${conflictId}`
};

export const WS_EVENTS = {
  // Connection
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  CONNECTED: 'connected',
  
  // Subscription
  SUBSCRIBE: 'subscribe',
  SUBSCRIBED: 'subscribed',
  UNSUBSCRIBE: 'unsubscribe',
  UNSUBSCRIBED: 'unsubscribed',
  
  // Sync
  FILE_UPDATE: 'file_update',
  FILE_UPDATE_ACK: 'file_update_ack',
  SYNC_EVENT: 'sync_event',
  
  // Conflicts
  CONFLICT: 'conflict',
  CONFLICT_RESOLVED: 'conflict_resolved',
  
  // Devices
  DEVICE_CONNECTED: 'device_connected',
  DEVICE_DISCONNECTED: 'device_disconnected',
  
  // Presence
  PRESENCE_UPDATE: 'presence_update',
  USER_JOINED: 'user_joined',
  USER_LEFT: 'user_left',
  
  // Collaboration
  COLLABORATOR_JOINED: 'collaborator_joined',
  COLLABORATOR_LEFT: 'collaborator_left',
  CURSOR_UPDATE: 'cursor_update',
  TYPING_INDICATOR: 'typing_indicator',
  
  // Heartbeat
  HEARTBEAT: 'heartbeat',
  PING: 'ping',
  PONG: 'pong',
  
  // Errors
  ERROR: 'error'
};

export const SYNC_DEBOUNCE_MS = 500; // 500ms for faster near-live sync
export const PRESENCE_HEARTBEAT_MS = 15000; // 15 seconds (reduced from 30 for real-time presence)
export const IDLE_TIMEOUT_MS = 180000; // 3 minutes (reduced from 5 for faster idle detection)
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 1000; // 1 second base
export const LARGE_FILE_THRESHOLD = 1048576; // 1MB
export const CACHE_TTL_MS = 120000; // 2 minutes
