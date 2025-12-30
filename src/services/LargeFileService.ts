import { APIClient } from '../api/APIClient';
import { EventBus, EVENTS } from '../core/EventBus';
import { SmartRetryService } from './SmartRetryService';
import { CompressionService } from './CompressionService';
import { UploadPersistenceService, PersistedUploadState } from './UploadPersistenceService';
import { Vault, TFile } from 'obsidian';

/**
 * Chunk information
 */
export interface ChunkInfo {
  index: number;
  start: number;
  end: number;
  size: number;
  hash: string;
}

/**
 * Upload progress
 */
export interface UploadProgress {
  uploadId: string;
  filePath: string;
  totalSize: number;
  uploadedSize: number;
  totalChunks: number;
  uploadedChunks: number;
  percentComplete: number;
  currentChunk: number;
  speed: number; // bytes per second
  estimatedTimeRemaining: number; // seconds
}

/**
 * Upload session
 */
interface UploadSession {
  uploadId: string;
  vaultId: string;
  filePath: string;
  content: string;
  totalSize: number;
  chunkSize: number;
  chunks: ChunkInfo[];
  uploadedChunks: Set<number>;
  startTime: number;
  lastProgressTime: number;
  lastUploadedSize: number;
  isPaused: boolean;
  isCancelled: boolean;
}

/**
 * Large file configuration
 */
export interface LargeFileConfig {
  chunkSize: number; // bytes
  largeFileThreshold: number; // bytes
  maxConcurrentChunks: number;
  retryAttempts: number;
  retryDelayMs: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: LargeFileConfig = {
  chunkSize: 1024 * 1024, // 1 MB
  largeFileThreshold: 1024 * 1024, // 1 MB
  maxConcurrentChunks: 3,
  retryAttempts: 3,
  retryDelayMs: 1000
};

/**
 * Large File Service
 * Handles large file uploads with chunking, progress tracking, and resumable uploads
 */
export class LargeFileService {
  private apiClient: APIClient;
  private eventBus: EventBus;
  private config: LargeFileConfig;
  private smartRetry: SmartRetryService;
  private compression: CompressionService;
  private persistence: UploadPersistenceService | null = null;
  private vault: Vault | null = null;
  
  // Active upload sessions
  private activeSessions: Map<string, UploadSession> = new Map();
  
  // Upload statistics
  private stats = {
    totalUploads: 0,
    successfulUploads: 0,
    failedUploads: 0,
    totalBytesUploaded: 0,
    totalBytesSaved: 0
  };

  constructor(
    apiClient: APIClient,
    eventBus: EventBus,
    config?: Partial<LargeFileConfig>
  ) {
    this.apiClient = apiClient;
    this.eventBus = eventBus;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.smartRetry = new SmartRetryService({
      maxAttempts: config?.retryAttempts || 3,
      baseDelayMs: config?.retryDelayMs || 1000
    });
    this.compression = new CompressionService();
  }

  /**
   * Initialize with persistence support
   */
  initializePersistence(persistence: UploadPersistenceService, vault: Vault): void {
    this.persistence = persistence;
    this.vault = vault;
    console.debug('[LargeFileService] Persistence enabled');
  }

  /**
   * Check if file should be uploaded in chunks
   */
  isLargeFile(content: string): boolean {
    const size = new Blob([content]).size;
    return size >= this.config.largeFileThreshold;
  }

  /**
   * Upload file with chunking if needed
   */
  async uploadFile(
    vaultId: string,
    filePath: string,
    content: string,
    fileId?: string
  ): Promise<void> {
    const size = new Blob([content]).size;
    
    if (size < this.config.largeFileThreshold) {
      // Upload normally for small files
      if (fileId) {
        await this.apiClient.updateFile(vaultId, fileId, { content });
      } else {
        await this.apiClient.createFile(vaultId, { path: filePath, content });
      }
      return;
    }
    
    // Upload in chunks for large files
    const uploadId = this.generateUploadId();
    await this.uploadInChunks(uploadId, vaultId, filePath, content, fileId);
  }

  /**
   * Start chunked upload
   */
  async uploadInChunks(
    uploadId: string,
    vaultId: string,
    filePath: string,
    content: string,
    fileId?: string
  ): Promise<void> {
    // Create upload session
    const session = this.createUploadSession(uploadId, vaultId, filePath, content);
    this.activeSessions.set(uploadId, session);
    this.stats.totalUploads++;
    
    try {
      // Emit upload started event
      this.eventBus.emit(EVENTS.UPLOAD_STARTED, {
        uploadId,
        filePath
      });
      
      this.emitProgress(session);
      
      // Upload chunks
      await this.uploadChunks(session);
      
      // Finalize upload
      await this.finalizeUpload(session, fileId);
      
      // Update statistics
      this.stats.successfulUploads++;
      this.stats.totalBytesUploaded += session.totalSize;
      
      // Emit upload completed event
      this.eventBus.emit(EVENTS.UPLOAD_COMPLETED, {
        uploadId,
        filePath,
        size: session.totalSize
      });
      
    } catch (error) {
      this.stats.failedUploads++;
      
      // Emit upload failed event
      this.eventBus.emit(EVENTS.UPLOAD_FAILED, {
        uploadId,
        filePath,
        error: (error as Error).message
      });
      
      throw error;
    } finally {
      this.activeSessions.delete(uploadId);
    }
  }

  /**
   * Create upload session
   */
  private createUploadSession(
    uploadId: string,
    vaultId: string,
    filePath: string,
    content: string
  ): UploadSession {
    const totalSize = new Blob([content]).size;
    const chunks = this.createChunks(content);
    
    return {
      uploadId,
      vaultId,
      filePath,
      content,
      totalSize,
      chunkSize: this.config.chunkSize,
      chunks,
      uploadedChunks: new Set(),
      startTime: Date.now(),
      lastProgressTime: Date.now(),
      lastUploadedSize: 0,
      isPaused: false,
      isCancelled: false
    };
  }

  /**
   * Create chunks from content
   */
  private createChunks(content: string): ChunkInfo[] {
    const chunks: ChunkInfo[] = [];
    const totalSize = new Blob([content]).size;
    const chunkSize = this.config.chunkSize;
    
    let start = 0;
    let index = 0;
    
    while (start < content.length) {
      const end = Math.min(start + chunkSize, content.length);
      const chunkContent = content.substring(start, end);
      const size = new Blob([chunkContent]).size;
      
      chunks.push({
        index,
        start,
        end,
        size,
        hash: this.hashChunk(chunkContent)
      });
      
      start = end;
      index++;
    }
    
    return chunks;
  }

  /**
   * Hash chunk content
   */
  private hashChunk(content: string): string {
    // Simple hash for chunk identification
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  /**
   * Upload chunks
   */
  private async uploadChunks(session: UploadSession): Promise<void> {
    const pendingChunks = session.chunks.filter(
      chunk => !session.uploadedChunks.has(chunk.index)
    );
    
    // Upload chunks in batches
    for (let i = 0; i < pendingChunks.length; i += this.config.maxConcurrentChunks) {
      if (session.isCancelled) {
        throw new Error('Upload cancelled');
      }
      
      if (session.isPaused) {
        await this.waitForResume(session);
      }
      
      const batch = pendingChunks.slice(i, i + this.config.maxConcurrentChunks);
      await Promise.all(
        batch.map(chunk => this.uploadChunkWithRetry(session, chunk))
      );
    }
  }

  /**
   * Upload a single chunk with smart retry
   */
  private async uploadChunkWithRetry(
    session: UploadSession,
    chunk: ChunkInfo
  ): Promise<void> {
    // Check circuit breaker
    if (this.smartRetry.isCircuitOpen()) {
      throw new Error('Circuit breaker open - too many failures. Please try again later.');
    }
    
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < this.config.retryAttempts; attempt++) {
      try {
        await this.uploadChunk(session, chunk);
        
        // Success - record it
        this.smartRetry.recordSuccess();
        
        // Mark chunk as uploaded
        session.uploadedChunks.add(chunk.index);
        
        // Emit progress
        this.emitProgress(session);
        
        return;
        
      } catch (error) {
        lastError = error as Error;
        
        // Check if error is retryable
        if (!this.smartRetry.isRetryableError(error)) {
          console.error(`[LargeFileService] Non-retryable error for chunk ${chunk.index}:`, error);
          throw error;
        }
        
        // Record failure
        this.smartRetry.recordFailure();
        
        // Log retry attempt
        console.warn(
          `[LargeFileService] Chunk ${chunk.index} upload failed (attempt ${attempt + 1}/${this.config.retryAttempts}):`,
          error
        );
        
        // Wait before retry with exponential backoff and jitter
        if (attempt < this.config.retryAttempts - 1) {
          const delay = this.smartRetry.calculateDelay(attempt);
          console.debug(`[LargeFileService] Retrying chunk ${chunk.index} in ${delay}ms`);
          await this.delay(delay);
        }
      }
    }
    
    // All retries failed
    const stats = this.smartRetry.getStats();
    console.error(
      `[LargeFileService] Failed to upload chunk ${chunk.index} after ${this.config.retryAttempts} attempts.`,
      `Circuit breaker stats:`, stats
    );
    
    throw lastError || new Error('Failed to upload chunk after all retries');
  }

  /**
   * Upload a single chunk
   */
  private async uploadChunk(session: UploadSession, chunk: ChunkInfo): Promise<void> {
    const chunkContent = session.content.substring(chunk.start, chunk.end);
    
    // Convert string to ArrayBuffer
    const encoder = new TextEncoder();
    let data = encoder.encode(chunkContent);
    let isCompressed = false;
    let compressionRatio = 0;
    
    // Try compression if file is compressible
    if (this.compression.isCompressible(session.filePath) && 
        !this.compression.isAlreadyCompressed(session.filePath) &&
        this.compression.isSupported()) {
      
      try {
        const compressionResult = await this.compression.compress(data.buffer);
        
        if (compressionResult.isCompressed) {
          data = new Uint8Array(compressionResult.data);
          isCompressed = true;
          compressionRatio = compressionResult.compressionRatio;
          
          // Track bytes saved
          const bytesSaved = compressionResult.originalSize - compressionResult.compressedSize;
          this.stats.totalBytesSaved += bytesSaved;
          
          console.debug(
            `[Compression] Chunk ${chunk.index}: ${compressionRatio.toFixed(1)}% reduction ` +
            `(${compressionResult.originalSize} → ${compressionResult.compressedSize} bytes)`
          );
        }
      } catch (error) {
        console.warn(`[Compression] Failed to compress chunk ${chunk.index}, using original:`, error);
      }
    }
    
    // Extract filename from path
    const filename = session.filePath.split('/').pop() || 'file';
    
    // Upload chunk via API
    const result = await this.apiClient.uploadChunk(session.vaultId, {
      filename,
      chunkIndex: chunk.index,
      totalChunks: session.chunks.length,
      chunkData: data.buffer,
      path: session.filePath,
      overwrite: true,
      compressed: isCompressed
    });
    
    const compressionInfo = isCompressed ? ` (compressed ${compressionRatio.toFixed(1)}%)` : '';
    console.debug(`Uploaded chunk ${chunk.index + 1}/${session.chunks.length} for ${session.filePath}${compressionInfo}`);
    
    // If this was the last chunk and upload is complete, we're done
    if (result.isComplete && result.file) {
      console.debug(`Chunked upload completed for ${session.filePath}`);
    }
  }

  /**
   * Finalize upload by combining chunks
   */
  private async finalizeUpload(session: UploadSession, fileId?: string): Promise<void> {
    // The backend automatically combines chunks when the last chunk is uploaded
    // No additional finalization needed
    console.debug(`Finalized chunked upload for ${session.filePath}`);
  }

  /**
   * Emit progress event
   */
  private emitProgress(session: UploadSession): void {
    const now = Date.now();
    const uploadedSize = session.uploadedChunks.size * session.chunkSize;
    const percentComplete = (session.uploadedChunks.size / session.chunks.length) * 100;
    
    // Calculate speed
    const timeDiff = (now - session.lastProgressTime) / 1000; // seconds
    const sizeDiff = uploadedSize - session.lastUploadedSize;
    const speed = timeDiff > 0 ? sizeDiff / timeDiff : 0;
    
    // Calculate estimated time remaining
    const remainingSize = session.totalSize - uploadedSize;
    const estimatedTimeRemaining = speed > 0 ? remainingSize / speed : 0;
    
    const progress: UploadProgress = {
      uploadId: session.uploadId,
      filePath: session.filePath,
      totalSize: session.totalSize,
      uploadedSize,
      totalChunks: session.chunks.length,
      uploadedChunks: session.uploadedChunks.size,
      percentComplete,
      currentChunk: session.uploadedChunks.size + 1,
      speed,
      estimatedTimeRemaining
    };
    
    // Update session
    session.lastProgressTime = now;
    session.lastUploadedSize = uploadedSize;
    
    // Emit event
    this.eventBus.emit(EVENTS.UPLOAD_PROGRESS, progress);
  }

  /**
   * Pause upload
   */
  pauseUpload(uploadId: string): boolean {
    const session = this.activeSessions.get(uploadId);
    if (!session) return false;
    
    session.isPaused = true;
    this.eventBus.emit(EVENTS.UPLOAD_PAUSED, { uploadId });
    return true;
  }

  /**
   * Resume upload
   */
  resumeUpload(uploadId: string): boolean {
    const session = this.activeSessions.get(uploadId);
    if (!session) return false;
    
    session.isPaused = false;
    this.eventBus.emit(EVENTS.UPLOAD_RESUMED, { uploadId });
    return true;
  }

  /**
   * Cancel upload
   */
  cancelUpload(uploadId: string): boolean {
    const session = this.activeSessions.get(uploadId);
    if (!session) return false;
    
    session.isCancelled = true;
    this.activeSessions.delete(uploadId);
    this.eventBus.emit(EVENTS.UPLOAD_CANCELLED, { uploadId });
    return true;
  }

  /**
   * Wait for upload to resume
   */
  private async waitForResume(session: UploadSession): Promise<void> {
    while (session.isPaused && !session.isCancelled) {
      await this.delay(100);
    }
  }

  /**
   * Get upload progress
   */
  getUploadProgress(uploadId: string): UploadProgress | null {
    const session = this.activeSessions.get(uploadId);
    if (!session) return null;
    
    const uploadedSize = session.uploadedChunks.size * session.chunkSize;
    const percentComplete = (session.uploadedChunks.size / session.chunks.length) * 100;
    
    const now = Date.now();
    const timeDiff = (now - session.lastProgressTime) / 1000;
    const sizeDiff = uploadedSize - session.lastUploadedSize;
    const speed = timeDiff > 0 ? sizeDiff / timeDiff : 0;
    
    const remainingSize = session.totalSize - uploadedSize;
    const estimatedTimeRemaining = speed > 0 ? remainingSize / speed : 0;
    
    return {
      uploadId: session.uploadId,
      filePath: session.filePath,
      totalSize: session.totalSize,
      uploadedSize,
      totalChunks: session.chunks.length,
      uploadedChunks: session.uploadedChunks.size,
      percentComplete,
      currentChunk: session.uploadedChunks.size + 1,
      speed,
      estimatedTimeRemaining
    };
  }

  /**
   * Get all active uploads
   */
  getActiveUploads(): UploadProgress[] {
    const uploads: UploadProgress[] = [];
    
    for (const [uploadId, _] of this.activeSessions) {
      const progress = this.getUploadProgress(uploadId);
      if (progress) {
        uploads.push(progress);
      }
    }
    
    return uploads;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalUploads: number;
    successfulUploads: number;
    failedUploads: number;
    totalBytesUploaded: number;
    activeUploads: number;
    successRate: number;
  } {
    const successRate = this.stats.totalUploads > 0
      ? (this.stats.successfulUploads / this.stats.totalUploads) * 100
      : 0;
    
    return {
      ...this.stats,
      activeUploads: this.activeSessions.size,
      successRate
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalUploads: 0,
      successfulUploads: 0,
      failedUploads: 0,
      totalBytesUploaded: 0,
      totalBytesSaved: 0
    };
  }

  /**
   * Generate unique upload ID
   */
  private generateUploadId(): string {
    return `upload_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<LargeFileConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get configuration
   */
  getConfig(): LargeFileConfig {
    return { ...this.config };
  }

  /**
   * Format bytes to human readable string
   */
  static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Format seconds to human readable string
   */
  static formatTime(seconds: number): string {
    if (seconds < 60) {
      return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const secs = Math.round(seconds % 60);
      return `${minutes}m ${secs}s`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    }
  }
}
