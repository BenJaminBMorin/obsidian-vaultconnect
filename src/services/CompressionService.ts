/**
 * Compression Service
 * Handles compression of file chunks before upload
 */

export interface CompressionResult {
  data: ArrayBuffer;
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  isCompressed: boolean;
}

export class CompressionService {
  private compressionThreshold = 0.1; // Only use if >10% savings

  /**
   * Check if file type is compressible
   */
  isCompressible(filePath: string): boolean {
    const compressibleExtensions = [
      // Text files
      '.txt', '.md', '.markdown',
      // Code files
      '.js', '.ts', '.jsx', '.tsx', '.json', '.xml', '.html', '.css', '.scss', '.sass',
      '.py', '.java', '.c', '.cpp', '.h', '.cs', '.php', '.rb', '.go', '.rs', '.swift',
      // Data files
      '.csv', '.tsv', '.log', '.yaml', '.yml', '.toml', '.ini', '.conf', '.config',
      // Documentation
      '.tex', '.rst', '.org', '.adoc',
      // Other text formats
      '.sql', '.sh', '.bash', '.ps1', '.bat', '.cmd'
    ];
    
    const ext = filePath.toLowerCase().substring(filePath.lastIndexOf('.'));
    return compressibleExtensions.includes(ext);
  }

  /**
   * Check if file type is already compressed
   */
  isAlreadyCompressed(filePath: string): boolean {
    const compressedExtensions = [
      // Images
      '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif',
      // Video
      '.mp4', '.mov', '.avi', '.mkv', '.webm',
      // Audio
      '.mp3', '.m4a', '.ogg', '.opus', '.aac',
      // Archives
      '.zip', '.gz', '.bz2', '.7z', '.rar', '.tar',
      // Documents
      '.pdf', '.docx', '.xlsx', '.pptx'
    ];
    
    const ext = filePath.toLowerCase().substring(filePath.lastIndexOf('.'));
    return compressedExtensions.includes(ext);
  }

  /**
   * Compress data using gzip
   */
  async compress(data: ArrayBuffer): Promise<CompressionResult> {
    const originalSize = data.byteLength;
    
    try {
      // Use browser's native CompressionStream API
      const stream = new Blob([data]).stream();
      const compressedStream = stream.pipeThrough(
        new CompressionStream('gzip')
      );
      
      // Read compressed data
      const compressedBlob = await new Response(compressedStream).blob();
      const compressedData = await compressedBlob.arrayBuffer();
      const compressedSize = compressedData.byteLength;
      
      // Calculate compression ratio
      const compressionRatio = ((originalSize - compressedSize) / originalSize) * 100;
      
      // Only use compression if it saves enough space
      const shouldCompress = compressionRatio > (this.compressionThreshold * 100);
      
      return {
        data: shouldCompress ? compressedData : data,
        originalSize,
        compressedSize: shouldCompress ? compressedSize : originalSize,
        compressionRatio: shouldCompress ? compressionRatio : 0,
        isCompressed: shouldCompress
      };
      
    } catch (error) {
      console.warn('[Compression] Failed to compress data, using original:', error);
      
      // Fallback to uncompressed
      return {
        data,
        originalSize,
        compressedSize: originalSize,
        compressionRatio: 0,
        isCompressed: false
      };
    }
  }

  /**
   * Decompress data using gzip
   */
  async decompress(data: ArrayBuffer): Promise<ArrayBuffer> {
    try {
      const stream = new Blob([data]).stream();
      const decompressedStream = stream.pipeThrough(
        new DecompressionStream('gzip')
      );
      
      const decompressedBlob = await new Response(decompressedStream).blob();
      return await decompressedBlob.arrayBuffer();
      
    } catch (error) {
      console.error('[Compression] Failed to decompress data:', error);
      throw new Error('Decompression failed');
    }
  }

  /**
   * Check if compression is supported
   */
  isSupported(): boolean {
    return typeof CompressionStream !== 'undefined' && 
           typeof DecompressionStream !== 'undefined';
  }

  /**
   * Get compression stats for a file
   */
  async analyzeCompression(
    data: ArrayBuffer,
    filePath: string
  ): Promise<{
    shouldCompress: boolean;
    estimatedRatio: number;
    reason: string;
  }> {
    // Check if already compressed
    if (this.isAlreadyCompressed(filePath)) {
      return {
        shouldCompress: false,
        estimatedRatio: 0,
        reason: 'File type already compressed'
      };
    }
    
    // Check if compressible
    if (!this.isCompressible(filePath)) {
      return {
        shouldCompress: false,
        estimatedRatio: 0,
        reason: 'File type not compressible'
      };
    }
    
    // Check if compression is supported
    if (!this.isSupported()) {
      return {
        shouldCompress: false,
        estimatedRatio: 0,
        reason: 'Compression not supported in this browser'
      };
    }
    
    // For small chunks, compression overhead may not be worth it
    if (data.byteLength < 1024) {
      return {
        shouldCompress: false,
        estimatedRatio: 0,
        reason: 'Chunk too small for compression'
      };
    }
    
    // Try compressing a sample to estimate ratio
    try {
      const result = await this.compress(data);
      
      return {
        shouldCompress: result.isCompressed,
        estimatedRatio: result.compressionRatio,
        reason: result.isCompressed 
          ? `${result.compressionRatio.toFixed(1)}% compression achieved`
          : 'Compression ratio too low'
      };
    } catch {
      return {
        shouldCompress: false,
        estimatedRatio: 0,
        reason: 'Compression test failed'
      };
    }
  }

  /**
   * Format compression stats for display
   */
  formatCompressionStats(result: CompressionResult): string {
    if (!result.isCompressed) {
      return 'No compression';
    }
    
    const saved = result.originalSize - result.compressedSize;
    const savedKB = (saved / 1024).toFixed(1);
    const ratio = result.compressionRatio.toFixed(1);
    
    return `Compressed: ${savedKB}KB saved (${ratio}%)`;
  }

  /**
   * Update compression threshold
   */
  setCompressionThreshold(threshold: number): void {
    this.compressionThreshold = Math.max(0, Math.min(1, threshold));
  }

  /**
   * Get current threshold
   */
  getCompressionThreshold(): number {
    return this.compressionThreshold;
  }
}
