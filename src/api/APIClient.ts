import { requestUrl, RequestUrlParam } from 'obsidian';
import { AuthService } from '../services/AuthService';
import { VaultInfo, FileInfo, FileContent, ConflictInfo, ConflictType } from '../types';
import { API_ENDPOINTS } from '../utils/constants';
import { retryWithBackoff, parseErrorMessage } from '../utils/helpers';
import { logger } from '../utils/logger';

export interface APIResponse<T> {
  data?: T;
  error?: {
    code: string;
    message: string;
    request_id?: string;
  };
}

export interface CreateFileRequest {
  path: string;
  content: string;
}

export interface UpdateFileRequest {
  content: string;
}

export interface ChunkUploadRequest {
  filename: string;
  chunkIndex: number;
  totalChunks: number;
  chunkData: ArrayBuffer;
  path: string;
  overwrite?: boolean;
  compressed?: boolean;
}

export interface ChunkUploadResponse {
  message: string;
  chunkIndex: number;
  totalChunks: number;
  isComplete: boolean;
  file?: FileInfo;
}

// API Response interfaces for type safety
interface VaultAPIResponse {
  vault_id: string;
  name: string;
  file_count: number;
  total_size_bytes: number;
  created_at: string;
  updated_at: string;
  is_cross_tenant?: boolean;
  permission?: 'read' | 'write' | 'admin';
  owner_tenant_id?: string;
}

interface VaultAccessAPIResponse {
  vault_id: string;
  is_cross_tenant: boolean;
  permission: 'read' | 'write' | 'admin';
  owner_tenant_id: string;
}

interface FileAPIResponse {
  file_id: string;
  vault_id: string;
  path: string;
  size_bytes: number;
  hash: string;
  created_at: string;
  updated_at: string;
  last_editor?: string;
}

interface FileContentAPIResponse {
  file_id: string;
  path: string;
  content: string;
  hash: string;
  created_at: string;
  updated_at: string;
}

interface ConflictAPIResponse {
  id: string;
  path: string;
  local_content: string;
  remote_content: string;
  local_modified: string;
  remote_modified: string;
  conflict_type: string;
  auto_resolvable: boolean;
}

interface BatchUpdateError {
  path: string;
  error: string;
}

// E2E Encryption response types
// Search types
export interface SearchResult {
  file_id: string;
  vault_id: string;
  path: string;
  similarity_score: number;
  content_preview: string;
  file_type: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface SemanticSearchParams {
  query: string;
  vault_id?: string;
  limit?: number;
  min_score?: number;
  file_types?: string[];
}

export interface SemanticSearchResponse {
  results: SearchResult[];
  total: number;
  query: string;
  executionTimeMs: number;
}

// Copy/Move response types
export interface CopyFilesResponse {
  success: boolean;
  copiedCount: number;
  files: Array<{
    file_id: string;
    path: string;
    created_at: string;
  }>;
}

export interface MoveFilesResponse {
  success: boolean;
  movedCount: number;
  files: Array<{
    file_id: string;
    old_path: string;
    new_path: string;
    updated_at: string;
  }>;
}

// E2E Encryption response types
export interface E2EKeyPairResponse {
  publicKey: string;
  encryptedPrivateKey: string;
  keyDerivationSalt: string;
  keyDerivationIterations: number;
}

export interface E2EPublicKeyResponse {
  userId: string;
  publicKey: string;
}

export interface E2EGrantResponse {
  vaultId: string;
  userId: string;
  encryptedVaultKey: string;
}

/**
 * API Client for VaultSync REST API
 */
export class APIClient {
  private authService: AuthService;
  private baseURL: string;

  constructor(authService: AuthService, baseURL: string) {
    this.authService = authService;
    this.baseURL = baseURL;
  }

  /**
   * Set base URL
   */
  setBaseURL(url: string): void {
    this.baseURL = url;
  }

  /**
   * Make authenticated request
   */
  private async request<T>(
    endpoint: string,
    options: { method?: string; body?: string; headers?: Record<string, string> } = {}
  ): Promise<T> {
    const apiKey = await this.authService.getApiKey();
    if (!apiKey) {
      throw new Error('Not authenticated');
    }

    const url = `${this.baseURL}${endpoint}`;
    const method = options.method || 'GET';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      ...(options.headers || {})
    };

    const requestParams: RequestUrlParam = {
      url,
      method,
      headers,
      body: options.body,
      throw: false
    };

    const response = await requestUrl(requestParams);

    // Log HTTP request using the logger's http method
    logger.http(method, endpoint, response.status);

    if (response.status >= 400) {
      const errorData = response.json || {};
      throw new Error(
        errorData.error?.message ||
        `HTTP ${response.status}`
      );
    }

    return response.json;
  }

  /**
   * Make request with retry
   */
  private async requestWithRetry<T>(
    endpoint: string,
    options: { method?: string; body?: string; headers?: Record<string, string> } = {},
    maxRetries: number = 3
  ): Promise<T> {
    return retryWithBackoff(
      () => this.request<T>(endpoint, options),
      maxRetries
    );
  }

  // Vault Endpoints

  /**
   * List all vaults
   */
  async listVaults(): Promise<VaultInfo[]> {
    const response = await this.requestWithRetry<{ vaults: VaultAPIResponse[] }>(
      API_ENDPOINTS.VAULTS
    );

    return response.vaults.map(v => ({
      vault_id: v.vault_id,
      name: v.name,
      file_count: v.file_count,
      total_size_bytes: v.total_size_bytes,
      created_at: new Date(v.created_at),
      updated_at: new Date(v.updated_at)
    }));
  }

  /**
   * Get vault by ID
   */
  async getVault(vaultId: string): Promise<VaultInfo> {
    const response = await this.requestWithRetry<VaultAPIResponse>(
      API_ENDPOINTS.VAULT(vaultId)
    );

    return {
      vault_id: response.vault_id,
      name: response.name,
      file_count: response.file_count,
      total_size_bytes: response.total_size_bytes,
      created_at: new Date(response.created_at),
      updated_at: new Date(response.updated_at),
      is_cross_tenant: response.is_cross_tenant,
      permission: response.permission,
      owner_tenant_id: response.owner_tenant_id
    };
  }

  /**
   * Get vault access information including cross-tenant status
   */
  async getVaultAccess(vaultId: string): Promise<{
    vault_id: string;
    is_cross_tenant: boolean;
    permission: 'read' | 'write' | 'admin';
    owner_tenant_id: string;
  }> {
    const response = await this.requestWithRetry<VaultAccessAPIResponse>(
      `/vaults/${vaultId}/access`
    );

    return {
      vault_id: response.vault_id,
      is_cross_tenant: response.is_cross_tenant,
      permission: response.permission,
      owner_tenant_id: response.owner_tenant_id
    };
  }

  /**
   * Create a new vault
   */
  async createVault(name: string): Promise<VaultInfo> {
    const response = await this.request<VaultAPIResponse>(
      API_ENDPOINTS.VAULTS,
      {
        method: 'POST',
        body: JSON.stringify({ name })
      }
    );

    return {
      vault_id: response.vault_id,
      name: response.name,
      file_count: response.file_count,
      total_size_bytes: response.total_size_bytes,
      created_at: new Date(response.created_at),
      updated_at: new Date(response.updated_at)
    };
  }

  // File Endpoints

  /**
   * List all files in a vault
   */
  async listFiles(vaultId: string): Promise<FileInfo[]> {
    const response = await this.requestWithRetry<{ files: FileAPIResponse[] }>(
      API_ENDPOINTS.FILES(vaultId)
    );

    return response.files.map(f => ({
      file_id: f.file_id,
      vault_id: f.vault_id,
      path: f.path,
      size_bytes: f.size_bytes,
      hash: f.hash,
      created_at: new Date(f.created_at),
      updated_at: new Date(f.updated_at)
    }));
  }

  /**
   * Get files that have changed since a specific timestamp (incremental sync)
   * This is much more efficient than listFiles() for periodic sync checks
   */
  async getChangedFiles(vaultId: string, since: Date): Promise<FileInfo[]> {
    const sinceISO = since.toISOString();
    const response = await this.requestWithRetry<{ files: FileAPIResponse[] }>(
      `${API_ENDPOINTS.FILES(vaultId)}/changes?since=${encodeURIComponent(sinceISO)}`
    );

    return response.files.map(f => ({
      file_id: f.file_id,
      vault_id: f.vault_id,
      path: f.path,
      size_bytes: f.size_bytes,
      hash: f.hash,
      created_at: new Date(f.created_at),
      updated_at: new Date(f.updated_at)
    }));
  }

  /**
   * Get file by path
   * Note: Does NOT retry on 404 errors since they're expected when file doesn't exist
   */
  async getFileByPath(vaultId: string, filePath: string): Promise<FileContent> {
    try {
      // Use direct request without retry for 404s
      const response = await this.request<FileContentAPIResponse>(
        API_ENDPOINTS.FILE_CONTENT(vaultId, filePath)
      );

      return {
        file_id: response.file_id,
        path: response.path,
        content: response.content,
        hash: response.hash,
        created_at: response.created_at,
        updated_at: response.updated_at
      };
    } catch (error) {
      // If it's a 404, throw immediately without retry
      if (error instanceof Error && error.message.includes('404')) {
        throw error;
      }
      // For other errors, retry
      const response = await this.requestWithRetry<FileContentAPIResponse>(
        API_ENDPOINTS.FILE_CONTENT(vaultId, filePath),
        {},
        2 // Only 2 retries for non-404 errors
      );

      return {
        file_id: response.file_id,
        path: response.path,
        content: response.content,
        hash: response.hash,
        created_at: response.created_at,
        updated_at: response.updated_at
      };
    }
  }

  /**
   * Create a new file
   */
  async createFile(vaultId: string, request: CreateFileRequest): Promise<FileInfo> {
    const response = await this.request<FileAPIResponse>(
      API_ENDPOINTS.FILES(vaultId),
      {
        method: 'POST',
        body: JSON.stringify(request)
      }
    );

    return {
      file_id: response.file_id,
      vault_id: response.vault_id,
      path: response.path,
      size_bytes: response.size_bytes,
      hash: response.hash,
      created_at: new Date(response.created_at),
      updated_at: new Date(response.updated_at)
    };
  }

  /**
   * Update a file
   */
  async updateFile(
    vaultId: string,
    fileId: string,
    request: UpdateFileRequest
  ): Promise<FileInfo> {
    const response = await this.request<FileAPIResponse>(
      API_ENDPOINTS.FILE(vaultId, fileId),
      {
        method: 'PUT',
        body: JSON.stringify(request)
      }
    );

    return {
      file_id: response.file_id,
      vault_id: response.vault_id,
      path: response.path,
      size_bytes: response.size_bytes,
      hash: response.hash,
      created_at: new Date(response.created_at),
      updated_at: new Date(response.updated_at)
    };
  }

  /**
   * Delete a file
   */
  async deleteFile(vaultId: string, fileId: string): Promise<void> {
    await this.request<void>(
      API_ENDPOINTS.FILE(vaultId, fileId),
      {
        method: 'DELETE'
      }
    );
  }

  /**
   * Get file hash
   */
  async getFileHash(vaultId: string, filePath: string): Promise<string> {
    const response = await this.requestWithRetry<{ hash: string }>(
      API_ENDPOINTS.FILE_HASH(vaultId, filePath)
    );
    
    return response.hash;
  }

  /**
   * Check if file exists (without logging 404 as error)
   * Uses HEAD request to avoid downloading file content
   */
  async fileExists(vaultId: string, filePath: string): Promise<boolean> {
    try {
      const apiKey = await this.authService.getApiKey();
      if (!apiKey) {
        throw new Error('Not authenticated');
      }

      const url = `${this.baseURL}${API_ENDPOINTS.FILE_CONTENT(vaultId, filePath)}`;

      // Use HEAD request to check existence without downloading content
      // Note: 404 responses are expected and normal when file doesn't exist
      const response = await requestUrl({
        url,
        method: 'HEAD',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        throw: false
      });

      // Return true if file exists (200), false for 404 or any other status
      // Don't log 404 as an error - it's expected behavior
      return response.status === 200;
    } catch (error) {
      // Network errors mean we can't determine existence
      logger.warn('[APIClient] Error checking file existence:', error);
      return false;
    }
  }

  /**
   * Upload a file chunk (for chunked uploads)
   * Uses base64 encoding for binary data to work with requestUrl
   */
  async uploadChunk(
    vaultId: string,
    request: ChunkUploadRequest
  ): Promise<ChunkUploadResponse> {
    const apiKey = await this.authService.getApiKey();
    if (!apiKey) {
      throw new Error('Not authenticated');
    }

    const url = `${this.baseURL}/vaults/${vaultId}/files/upload/chunk`;

    // Build multipart/form-data body manually (Obsidian's requestUrl doesn't support FormData)
    const boundary = '----VaultConnectChunk' + Date.now();
    const chunkData = new Uint8Array(request.chunkData);

    // Build the multipart parts as text fields + file field
    const textParts = [
      ['filename', request.filename],
      ['chunkIndex', String(request.chunkIndex)],
      ['totalChunks', String(request.totalChunks)],
      ['path', request.path || ''],
      ['overwrite', String(request.overwrite ?? true)],
      ['compressed', String(request.compressed ?? false)],
    ];

    // Build header bytes
    let headerStr = '';
    for (const [key, value] of textParts) {
      headerStr += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
    }
    headerStr += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${request.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;

    const footerStr = `\r\n--${boundary}--\r\n`;

    // Combine into a single ArrayBuffer
    const headerBytes = new TextEncoder().encode(headerStr);
    const footerBytes = new TextEncoder().encode(footerStr);
    const body = new Uint8Array(headerBytes.length + chunkData.length + footerBytes.length);
    body.set(headerBytes, 0);
    body.set(chunkData, headerBytes.length);
    body.set(footerBytes, headerBytes.length + chunkData.length);

    const response = await requestUrl({
      url,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bearer ${apiKey}`
      },
      body: body.buffer,
      throw: false
    });

    if (response.status >= 400) {
      const errorData = response.json || {};
      throw new Error(
        errorData.error?.message ||
        `Chunk upload failed: HTTP ${response.status}`
      );
    }

    const result = response.json;

    // Map response to ChunkUploadResponse
    return {
      message: result.message,
      chunkIndex: result.chunkIndex,
      totalChunks: result.totalChunks,
      isComplete: result.isComplete,
      file: result.file ? {
        file_id: result.file.file_id,
        vault_id: result.file.vault_id,
        path: result.file.path,
        size_bytes: result.file.size_bytes,
        hash: result.file.hash,
        created_at: new Date(result.file.created_at),
        updated_at: new Date(result.file.updated_at)
      } : undefined
    };
  }

  // Batch Operations

  /**
   * Batch create/update files
   */
  async batchUpdateFiles(
    vaultId: string,
    operations: Array<{
      path: string;
      content: string;
      operation: 'create' | 'update';
    }>
  ): Promise<{ success: number; failed: number; errors: BatchUpdateError[] }> {
    const results = {
      success: 0,
      failed: 0,
      errors: [] as BatchUpdateError[]
    };

    // Process in batches of 5
    const batchSize = 5;
    for (let i = 0; i < operations.length; i += batchSize) {
      const batch = operations.slice(i, i + batchSize);
      
      await Promise.allSettled(
        batch.map(async (op) => {
          try {
            if (op.operation === 'create') {
              await this.createFile(vaultId, {
                path: op.path,
                content: op.content
              });
            } else {
              // For update, we need to get the file ID first
              const file = await this.getFileByPath(vaultId, op.path);
              await this.updateFile(vaultId, file.file_id, {
                content: op.content
              });
            }
            results.success++;
          } catch (error) {
            results.failed++;
            results.errors.push({
              path: op.path,
              error: parseErrorMessage(error)
            });
          }
        })
      );
    }

    return results;
  }

  // Conflict Endpoints

  /**
   * Get conflicts for a vault
   */
  async getConflicts(vaultId: string): Promise<ConflictInfo[]> {
    const response = await this.requestWithRetry<{ conflicts: ConflictAPIResponse[] }>(
      API_ENDPOINTS.CONFLICTS(vaultId)
    );

    return response.conflicts.map(c => ({
      id: c.id,
      path: c.path,
      localContent: c.local_content,
      remoteContent: c.remote_content,
      localModified: new Date(c.local_modified),
      remoteModified: new Date(c.remote_modified),
      conflictType: c.conflict_type as ConflictType,
      autoResolvable: c.auto_resolvable
    }));
  }

  /**
   * Resolve a conflict
   */
  async resolveConflict(
    conflictId: string,
    resolution: {
      strategy: string;
      content?: string;
    }
  ): Promise<void> {
    await this.request<void>(
      API_ENDPOINTS.CONFLICT(conflictId),
      {
        method: 'POST',
        body: JSON.stringify(resolution)
      }
    );
  }

  // E2E Encryption API

  /**
   * Create a new E2E key pair on the server
   */
  async createE2EKeyPair(data: {
    publicKey: string;
    encryptedPrivateKey: string;
    keyDerivationSalt: string;
    keyDerivationIterations?: number;
  }): Promise<E2EKeyPairResponse> {
    return this.request<E2EKeyPairResponse>('/e2e/keys', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /**
   * Get own E2E key pair from the server
   */
  async getE2EKeyPair(): Promise<E2EKeyPairResponse> {
    return this.request<E2EKeyPairResponse>('/e2e/keys');
  }

  /**
   * Get another user's public key
   */
  async getE2EPublicKey(userId: string): Promise<E2EPublicKeyResponse> {
    return this.request<E2EPublicKeyResponse>(`/e2e/keys/${userId}/public`);
  }

  /**
   * Get the E2E vault key grant for the current user
   */
  async getE2EGrant(vaultId: string): Promise<E2EGrantResponse> {
    return this.request<E2EGrantResponse>(`/vaults/${vaultId}/e2e/grants`);
  }

  /**
   * Create an E2E vault key grant
   */
  async createE2EGrant(vaultId: string, data: {
    userId: string;
    encryptedVaultKey: string;
  }): Promise<E2EGrantResponse> {
    return this.request<E2EGrantResponse>(`/vaults/${vaultId}/e2e/grants`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Search

  /**
   * Semantic search across vaults
   */
  async semanticSearch(params: SemanticSearchParams): Promise<SemanticSearchResponse> {
    return this.request<SemanticSearchResponse>(
      API_ENDPOINTS.SEMANTIC_SEARCH,
      {
        method: 'POST',
        body: JSON.stringify(params)
      }
    );
  }

  // Copy/Move

  /**
   * Copy files to another vault
   */
  async copyFiles(
    sourceVaultId: string,
    fileIds: string[],
    destinationPath: string,
    destinationVaultId?: string
  ): Promise<CopyFilesResponse> {
    return this.request<CopyFilesResponse>(
      API_ENDPOINTS.COPY_FILES(sourceVaultId),
      {
        method: 'POST',
        body: JSON.stringify({
          fileIds,
          destinationPath,
          destinationVaultId
        })
      }
    );
  }

  /**
   * Move files to another vault
   */
  async moveFiles(
    sourceVaultId: string,
    fileIds: string[],
    destinationPath: string,
    destinationVaultId?: string
  ): Promise<MoveFilesResponse> {
    return this.request<MoveFilesResponse>(
      API_ENDPOINTS.MOVE_FILES(sourceVaultId),
      {
        method: 'POST',
        body: JSON.stringify({
          fileIds,
          destinationPath,
          destinationVaultId
        })
      }
    );
  }

  // Health Check

  /**
   * Check API health
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: `${this.baseURL}/health`,
        method: 'GET',
        throw: false
      });
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  }
}
