import { App, Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TAbstractFile, Menu } from 'obsidian';
import { io, Socket } from 'socket.io-client';
import { SyncService, SyncMode } from './src/services/SyncService';
import { FileSyncService } from './src/services/FileSyncService';
import { LargeFileService, UploadProgress } from './src/services/LargeFileService';
import { ConflictService } from './src/services/ConflictService';
import { SyncLogService } from './src/services/SyncLogService';
import { SyncLogModal } from './src/ui/SyncLogModal';
import { UploadProgressModal } from './src/ui/UploadProgressModal';
import { ConflictListView, CONFLICT_LIST_VIEW_TYPE } from './src/ui/ConflictListView';
import { ConflictResolutionModal } from './src/ui/ConflictResolutionModal';
import { APIClient } from './src/api/APIClient';
import { EventBus, EVENTS } from './src/core/EventBus';
import { StorageManager } from './src/core/StorageManager';
import { showConfirmationModal } from './src/ui/ConfirmationModal';
import { InitialSyncService } from './src/services/InitialSyncService';
import { InitialSyncState } from './src/types/initial-sync.types';
import { logger, LogLevel, LOG_LEVEL_NAMES, LOG_LEVEL_DESCRIPTIONS } from './src/utils/logger';
import { VaultService } from './src/services/VaultService';
import { AuthService } from './src/services/AuthService';
import { VaultInfo } from './src/types';
import { requestUrl } from 'obsidian';

// Event data types
interface SyncEventData {
	file_path: string;
	operation: 'create' | 'modify' | 'delete' | 'rename';
	device_id?: string;
	old_path?: string;
	hash?: string;
}

interface ConflictEventData {
	file_path: string;
	local_hash: string;
	remote_hash: string;
}

interface VaultSyncSettings {
	apiUrl: string;
	wsUrl: string;
	apiKey: string;
	vaultId: string;
	deviceId: string;
	includedFolders: string[];
	excludedFolders: string[];
	autoSync: boolean;
	syncMode: SyncMode;
	// Additional settings from PluginSettings type
	apiKeyExpires: Date | null;
	selectedVaultId: string | null;
	syncInterval: number;
	collaborationEnabled: boolean;
	showPresence: boolean;
	showCursors: boolean;
	showTypingIndicators: boolean;
	notifyOnSync: boolean;
	notifyOnConflict: boolean;
	notifyOnCollaboratorJoin: boolean;
	maxConcurrentUploads: number;
	chunkSize: number;
	cacheEnabled: boolean;
	apiBaseURL: string;
	wsBaseURL: string;
	debugMode: boolean;
	logLevel: number; // LogLevel enum value
	// Initial sync states per vault
	initialSyncStates: { [vaultId: string]: InitialSyncState };
}

const DEFAULT_SETTINGS: VaultSyncSettings = {
	apiUrl: 'http://localhost:3001/v1',
	wsUrl: 'http://localhost:3001',
	apiKey: '',
	vaultId: '',
	deviceId: '',
	includedFolders: [],
	excludedFolders: ['.trash'], // .obsidian will be added dynamically in loadSettings
	autoSync: true,
	syncMode: SyncMode.SMART_SYNC,
	apiKeyExpires: null,
	selectedVaultId: null,
	syncInterval: 30,
	collaborationEnabled: false,
	showPresence: true,
	showCursors: true,
	showTypingIndicators: true,
	notifyOnSync: false,
	notifyOnConflict: true,
	notifyOnCollaboratorJoin: true,
	maxConcurrentUploads: 5,
	chunkSize: 1048576,
	cacheEnabled: true,
	apiBaseURL: 'http://localhost:3001/v1',
	wsBaseURL: 'http://localhost:3001',
	debugMode: false,
	logLevel: 3, // LogLevel.INFO
	initialSyncStates: {}
}

export default class VaultSyncPlugin extends Plugin {
	settings: VaultSyncSettings;
	socket: Socket | null = null;
	statusBarItem: HTMLElement;
	ribbonIconEl: HTMLElement | null = null;
	isConnected: boolean = false;
	isSyncing: boolean = false;
	private fileChangeDebounce: Map<string, NodeJS.Timeout> = new Map();

	// Notification batching
	private notificationBatch: Map<string, { files: string[], timeout: NodeJS.Timeout }> = new Map();
	private readonly BATCH_DELAY_MS = 2000; // 2 second delay for batching

	// Services
	apiClient: APIClient | null = null; // Public for settings tab
	private eventBus: EventBus | null = null;
	private storage: StorageManager | null = null;
	private syncService: SyncService | null = null;
	private fileSyncService: FileSyncService | null = null;
	private largeFileService: LargeFileService | null = null;
	vaultService: VaultService | null = null; // Public for settings tab
	private conflictService: ConflictService | null = null;
	private syncLogService: SyncLogService | null = null;
	initialSyncService: InitialSyncService | null = null; // Public for SettingsTab access
	authService: AuthService | null = null; // Public for SettingsTab access
	
	// Upload progress tracking
	private uploadProgressModal: UploadProgressModal | null = null;
	private uploadStatusBarItem: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		// Initialize logger with user's log level
		logger.setLevel(this.settings.logLevel as LogLevel);
		logger.info('VaultConnect plugin loading...');

		// Generate device ID if not exists
		if (!this.settings.deviceId) {
			this.settings.deviceId = `obsidian-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
			await this.saveSettings();
		}

		// Initialize services
		this.initializeServices();

		// Add status bar item
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar('disconnected');

		// Register conflict list view
		this.registerView(
			CONFLICT_LIST_VIEW_TYPE,
			(leaf) => new ConflictListView(leaf, this.conflictService!)
		);

		// Add ribbon icon with menu
		this.ribbonIconEl = this.addRibbonIcon('sync', 'Vault connect', (evt: MouseEvent) => {
			this.showSyncMenu(evt);
		});
		this.updateRibbonIcon();

		// Add settings tab
		this.addSettingTab(new VaultSyncSettingTab(this.app, this));

		// Register file events
		this.registerFileEvents();

		// Register all commands
		this.registerCommands();

		// Connect if settings are configured
		if (this.settings.apiKey && this.settings.vaultId && this.settings.autoSync) {
			await this.connect();
		}

		logger.info('VaultConnect plugin loaded');
	}

	/**
	 * Initialize services
	 */
	private initializeServices(): void {
		// Initialize core services
		this.eventBus = new EventBus();
		this.storage = new StorageManager(this);

		// Initialize auth service
		this.authService = new AuthService(this, this.eventBus);

		this.apiClient = new APIClient(this.authService, this.settings.apiUrl);

		// Initialize vault service
		this.vaultService = new VaultService(
			this,
			this.apiClient,
			this.storage,
			this.eventBus
		);

		// Initialize sync log service
		this.syncLogService = new SyncLogService(this.eventBus, this.storage);

		// Initialize conflict service
		this.conflictService = new ConflictService(
			this.app.vault,
			this.apiClient,
			this.eventBus,
			this.storage
		);

		// Initialize large file service for chunked uploads
		this.largeFileService = new LargeFileService(
			this.apiClient,
			this.eventBus,
			{
				chunkSize: this.settings.chunkSize,
				largeFileThreshold: 5 * 1024 * 1024, // 5MB threshold
				maxConcurrentChunks: 3,
				retryAttempts: 3,
				retryDelayMs: 1000
			}
		);

		// Initialize file sync service (used by both SyncService and InitialSyncService)
		this.fileSyncService = new FileSyncService(
			this.app.vault,
			this.apiClient,
			this.eventBus,
			this.storage,
			this.largeFileService
		);

		// Initialize sync service
		this.syncService = new SyncService(
			this.app.vault,
			this.apiClient,
			this.eventBus,
			this.storage,
			{
				mode: this.settings.syncMode,
				autoSync: this.settings.autoSync,
				includedFolders: this.settings.includedFolders,
				excludedFolders: this.settings.excludedFolders,
				configDir: this.app.vault.configDir,
				debounceDelay: 1000,
				maxRetries: 3,
				retryDelayMs: 1000,
				maxRetryDelayMs: 30000,
				maxConcurrent: 5
			}
		);

		// Initialize initial sync service
		this.initialSyncService = new InitialSyncService(
			this.app,
			this.apiClient,
			this.fileSyncService, // Use the dedicated FileSyncService instance
			this.storage,
			this.eventBus,
			{
				excludedFolders: this.settings.excludedFolders
			}
		);

		// Setup upload progress handlers
		this.setupUploadProgressHandlers();

		logger.debug('Services initialized');
	}

	/**
	 * Setup upload progress event handlers
	 */
	private setupUploadProgressHandlers(): void {
		if (!this.eventBus) return;

		// Handle upload started
		this.eventBus.on(EVENTS.UPLOAD_STARTED, (data: { uploadId: string; filePath: string }) => {
			logger.debug(`[Upload] Started: ${data.filePath}`);
		});

		// Handle upload progress
		this.eventBus.on(EVENTS.UPLOAD_PROGRESS, (progress: UploadProgress) => {
			this.updateUploadProgress(progress);
		});

		// Handle upload completed
		this.eventBus.on(EVENTS.UPLOAD_COMPLETED, (data: { uploadId: string; filePath: string; size: number }) => {
			logger.debug(`[Upload] Completed: ${data.filePath}`);
			this.clearUploadProgress();
			new Notice(`Upload completed: ${data.filePath}`);
		});

		// Handle upload failed
		this.eventBus.on(EVENTS.UPLOAD_FAILED, (data: { uploadId: string; filePath: string; error: string }) => {
			logger.error(`[Upload] Failed: ${data.filePath}`, data.error);
			this.clearUploadProgress();
			new Notice(`Upload failed: ${data.filePath}\n${data.error}`, 10000);
		});

		// Handle upload cancelled
		this.eventBus.on(EVENTS.UPLOAD_CANCELLED, (data: { uploadId: string }) => {
			logger.debug(`[Upload] Cancelled: ${data.uploadId}`);
			this.clearUploadProgress();
			new Notice('Upload cancelled');
		});
	}

	/**
	 * Update upload progress UI
	 */
	private updateUploadProgress(progress: UploadProgress): void {
		// Update status bar
		if (!this.uploadStatusBarItem) {
			this.uploadStatusBarItem = this.addStatusBarItem();
			this.uploadStatusBarItem.addClass('status-bar-upload-progress');
		}

		const percent = progress.percentComplete.toFixed(0);
		const speed = this.formatBytes(progress.speed);
		const eta = this.formatTime(progress.estimatedTimeRemaining);

		this.uploadStatusBarItem.setText(`⬆️ ${percent}% • ${speed}/s • ${eta}`);

		// Show modal for large uploads (>20MB)
		if (progress.totalSize > 20 * 1024 * 1024 && !this.uploadProgressModal) {
			this.uploadProgressModal = new UploadProgressModal(
				this.app,
				progress,
				() => {
					if (this.largeFileService) {
						this.largeFileService.cancelUpload(progress.uploadId);
					}
				}
			);
			this.uploadProgressModal.open();
		}

		// Update existing modal
		if (this.uploadProgressModal) {
			this.uploadProgressModal.updateProgress(progress);
		}
	}

	/**
	 * Clear upload progress UI
	 */
	private clearUploadProgress(): void {
		if (this.uploadStatusBarItem) {
			this.uploadStatusBarItem.remove();
			this.uploadStatusBarItem = null;
		}

		if (this.uploadProgressModal) {
			this.uploadProgressModal.close();
			this.uploadProgressModal = null;
		}
	}

	/**
	 * Format bytes to human readable
	 */
	private formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return Math.round((bytes / Math.pow(k, i)) * 10) / 10 + ' ' + sizes[i];
	}

	/**
	 * Format time to human readable
	 */
	private formatTime(seconds: number): string {
		if (seconds < 0 || !isFinite(seconds)) return '...';
		if (seconds < 60) return `${Math.round(seconds)}s`;
		const minutes = Math.floor(seconds / 60);
		const secs = Math.round(seconds % 60);
		return `${minutes}m ${secs}s`;
	}

	/**
	 * Register all commands
	 */
	private registerCommands(): void {
		// Connect command
		this.addCommand({
			id: 'connect',
			name: 'Connect',
			icon: 'plug-zap',
			callback: async () => {
				try {
					await this.connect();
				} catch (error) {
					logger.error('Connect command failed:', error);
					new Notice('Failed to connect');
				}
			}
		});

		// Disconnect command
		this.addCommand({
			id: 'disconnect',
			name: 'Disconnect',
			icon: 'plug-zap-off',
			callback: () => {
				try {
					this.disconnect();
				} catch (error) {
					logger.error('Disconnect command failed:', error);
					new Notice('Failed to disconnect');
				}
			}
		});

		// Pull all command
		this.addCommand({
			id: 'pull-all',
			name: 'Pull all',
			icon: 'download',
			callback: async () => {
				try {
					await this.performPullAll();
				} catch (error) {
					logger.error('Pull all command failed:', error);
					new Notice('Pull all failed');
				}
			}
		});

		// Push all command
		this.addCommand({
			id: 'push-all',
			name: 'Push all',
			icon: 'upload',
			callback: async () => {
				try {
					await this.performPushAll();
				} catch (error) {
					logger.error('Push all command failed:', error);
					new Notice('Push all failed');
				}
			}
		});

		// Force sync command
		this.addCommand({
			id: 'force-sync',
			name: 'Force sync',
			icon: 'zap',
			callback: async () => {
				try {
					await this.performForceSync();
				} catch (error) {
					logger.error('Force sync command failed:', error);
					new Notice('Force sync failed');
				}
			}
		});

		// View conflicts command
		this.addCommand({
			id: 'view-conflicts',
			name: 'View conflicts',
			icon: 'alert-triangle',
			callback: () => this.viewConflicts()
		});

		// View sync log command
		this.addCommand({
			id: 'view-sync-log',
			name: 'View sync log',
			icon: 'file-text',
			callback: () => this.viewSyncLog()
		});

		// Smart sync command
		this.addCommand({
			id: 'smart-sync',
			name: 'Smart sync',
			icon: 'refresh-cw',
			callback: async () => {
				try {
					await this.performSmartSync();
				} catch (error) {
					logger.error('Smart sync command failed:', error);
					new Notice('Smart sync failed');
				}
			}
		});

		logger.debug('Commands registered');
	}

	onunload() {
		this.disconnect();
		logger.info('VaultConnect plugin unloaded');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		// Ensure configDir is always in excludedFolders
		const configDir = this.app.vault.configDir;
		if (!this.settings.excludedFolders.includes(configDir)) {
			// Add the correct configDir
			this.settings.excludedFolders = this.settings.excludedFolders.concat([configDir]);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	registerFileEvents() {
		// File created
		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				if (file instanceof TFile) {
					// Forward to SyncService which handles selective sync internally
					if (this.syncService) {
						this.syncService.handleFileCreate(file);
					}
				}
			})
		);

		// File modified
		this.registerEvent(
			this.app.vault.on('modify', (file: TAbstractFile) => {
				if (file instanceof TFile) {
					// Forward to SyncService which handles selective sync internally
					if (this.syncService) {
						this.syncService.handleFileModify(file);
					}
				}
			})
		);

		// File deleted
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				if (file instanceof TFile) {
					// Forward to SyncService which handles selective sync internally
					if (this.syncService) {
						this.syncService.handleFileDelete(file);
					}
				}
			})
		);

		// File renamed
		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile) {
					// Forward to SyncService which handles selective sync internally
					if (this.syncService) {
						this.syncService.handleFileRename(file, oldPath);
					}
				}
			})
		);
	}

	shouldSyncFile(file: TFile): boolean {
		const path = file.path;

		// Check if file is in excluded folders
		for (const folder of this.settings.excludedFolders) {
			if (path.startsWith(folder + '/') || path === folder) {
				return false;
			}
		}

		// If there are included folders specified, check if path is in one of them
		if (this.settings.includedFolders.length > 0) {
			for (const folder of this.settings.includedFolders) {
				if (path.startsWith(folder + '/') || path === folder) {
					return true;
				}
			}
			// Path is not in any included folder
			return false;
		}

		// No included folders specified, so sync everything that's not excluded
		return true;
	}

	handleFileChange(file: TFile, action: 'create' | 'modify' | 'delete') {
		if (!this.isConnected || !this.settings.autoSync) {
			return;
		}

		// Debounce file changes to avoid excessive sync
		const existingTimeout = this.fileChangeDebounce.get(file.path);
		if (existingTimeout) {
			clearTimeout(existingTimeout);
		}

		const timeout = setTimeout(() => {
			void (async () => {
				this.fileChangeDebounce.delete(file.path);
				await this.syncFile(file, action);
			})();
		}, 1000); // 1 second debounce

		this.fileChangeDebounce.set(file.path, timeout);
	}

	handleFileRename(file: TFile, oldPath: string) {
		if (!this.isConnected || !this.settings.autoSync) {
			return;
		}

		// Handle rename as delete old + create new
		void this.syncFileRename(oldPath, file.path);
	}

	async syncFile(file: TFile, action: 'create' | 'modify' | 'delete') {
		try {
			this.isSyncing = true;
			this.updateStatusBar('syncing');

			let content = '';
			let hash = '';

			if (action !== 'delete') {
				content = await this.app.vault.read(file);
				hash = await this.computeHash(content);
			}

			if (this.socket && this.socket.connected) {
				this.socket.emit('file_update', {
					vault_id: this.settings.vaultId,
					file_path: file.path,
					content: content,
					hash: hash,
					action: action,
					timestamp: Date.now()
				});
			}

			this.isSyncing = false;
			this.updateStatusBar('connected');
		} catch (error) {
			logger.error('Error syncing file:', error);
			new Notice(`Failed to sync ${file.path}: ${error.message}`);
			this.isSyncing = false;
			this.updateStatusBar('error');
		}
	}

	syncFileRename(oldPath: string, newPath: string) {
		try {
			if (this.socket && this.socket.connected) {
				this.socket.emit('file_rename', {
					vault_id: this.settings.vaultId,
					old_path: oldPath,
					new_path: newPath,
					timestamp: Date.now()
				});
			}
		} catch (error) {
			logger.error('Error syncing file rename:', error);
			new Notice(`Failed to sync rename: ${error.message}`);
		}
	}

	async computeHash(content: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(content);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}

	/**
	 * Show initial sync wizard for first-time connection
	 * Analyzes files and presents sync options to the user
	 */
	async showInitialSyncWizard(): Promise<void> {
		if (!this.initialSyncService || !this.settings.vaultId || !this.eventBus) {
			logger.error('[VaultConnect] Cannot show initial sync wizard: service or vault ID not available');
			throw new Error('Initial sync service not available');
		}

		try {
			logger.debug('[VaultConnect] Starting file analysis for initial sync...');
			new Notice('Analyzing files for first-time setup...');

			// Analyze files
			const analysis = await this.initialSyncService.analyzeFiles(this.settings.vaultId);

			logger.debug('[VaultConnect] File analysis complete:', {
				localOnly: analysis.localFiles.length,
				remoteOnly: analysis.remoteFiles.length,
				both: analysis.commonFiles.length,
				excluded: analysis.excludedFiles.length
			});

			// Import the wizard modal
			const { InitialSyncWizardModal } = await import('./src/ui/InitialSyncWizardModal');

			// Store references for use in closure
			const initialSyncService = this.initialSyncService;
			const eventBus = this.eventBus;

			// Show wizard modal
			return new Promise<void>((resolve, reject) => {
				const modal = new InitialSyncWizardModal(
					this.app,
					{
						vaultId: this.settings.vaultId,
						vaultName: this.settings.vaultId.substring(0, 8) + '...', // Show truncated ID
						analysis,
						onComplete: (option) => {
							logger.debug('[VaultConnect] Initial sync completed with option:', option);
							resolve();
							return Promise.resolve();
						},
						onCancel: () => {
							logger.debug('[VaultConnect] Initial sync cancelled by user');
							reject(new Error('Initial sync cancelled by user'));
						}
					},
					initialSyncService,
					eventBus
				);

				modal.open();
			});
		} catch (error) {
			logger.error('[VaultConnect] Error during initial sync wizard:', error);
			new Notice(`Initial sync setup failed: ${error.message}`);
			throw error;
		}
	}

	async connect() {
		if (!this.settings.apiKey) {
			new Notice('Please configure your API key in settings');
			return;
		}

		if (!this.settings.vaultId) {
			new Notice('Please select a vault in settings');
			return;
		}

		if (this.socket && this.socket.connected) {
			new Notice('Already connected');
			return;
		}

		try {
			logger.debug('[VaultConnect] Connecting with vault ID:', this.settings.vaultId);
			this.updateStatusBar('connecting');

			// Get vault information for cross-tenant detection
			let isCrossTenant = false;
			let permission: 'read' | 'write' | 'admin' = 'admin';
			
			if (this.vaultService) {
				try {
					await this.vaultService.selectVault(this.settings.vaultId);
					isCrossTenant = this.vaultService.isCrossTenantVault();
					permission = this.vaultService.getCurrentVaultPermission() || 'admin';
					logger.debug('[VaultConnect] Vault info:', { isCrossTenant, permission });
				} catch (error) {
					logger.warn('[VaultConnect] Failed to get vault info:', error);
				}
			}

			// Initialize fileSyncService early so it can be used by initial sync wizard
			if (this.fileSyncService) {
				logger.debug('[VaultConnect] Pre-initializing FileSyncService for initial sync');
				await this.fileSyncService.initialize(this.settings.vaultId, isCrossTenant, permission);
			}

			// Check if this is first-time connection
			let completedInitialSync = false;
			if (this.initialSyncService) {
				const isFirstTime = await this.initialSyncService.isFirstTimeConnection(this.settings.vaultId);
				
				if (isFirstTime) {
					logger.debug('[VaultConnect] First-time connection detected, showing initial sync wizard');
					try {
						// Show initial sync wizard and wait for completion
						await this.showInitialSyncWizard();
						completedInitialSync = true;
						logger.debug('[VaultConnect] Initial sync wizard completed successfully');
					} catch (error) {
						// User cancelled or error occurred
						logger.debug('[VaultConnect] Initial sync wizard was cancelled or failed:', error.message);
						this.updateStatusBar('disconnected');
						return; // Don't proceed with connection
					}
				}
			}

			// Initialize remaining services with vault
			if (this.syncService && this.conflictService) {
				logger.debug('[VaultConnect] Initializing remaining services with vault ID:', this.settings.vaultId);
				await this.syncService.initialize(this.settings.vaultId, isCrossTenant, permission);
				await this.conflictService.initialize(this.settings.vaultId, isCrossTenant, permission);
				this.syncService.start();
				logger.debug('[VaultConnect] Services initialized successfully');
			}

			this.socket = io(this.settings.wsUrl, {
				auth: {
					token: this.settings.apiKey
				},
				transports: ['websocket'],
				reconnection: true,
				reconnectionDelay: 1000,
				reconnectionDelayMax: 5000,
				reconnectionAttempts: Infinity
			});

			this.socket.on('connect', () => {
				void (async () => {
				logger.debug('Connected to VaultConnect');
				this.isConnected = true;
				this.updateStatusBar('connected');
				
				// Show appropriate success message
				if (completedInitialSync) {
					new Notice('Initial sync complete! Connected to vault connect');
				} else {
					new Notice('Connected to vault connect');
				}

				// Subscribe to vault
				if (this.socket) {
					this.socket.emit('subscribe', {
						vault_id: this.settings.vaultId,
						device_id: this.settings.deviceId
					});
				}

				// Trigger reconnection sync check
				if (this.syncService && !completedInitialSync) {
					logger.debug('[VaultConnect] Triggering reconnection sync check...');
					await this.syncService.handleReconnection();
				}
				})();
			});

			this.socket.on('disconnect', () => {
				logger.debug('Disconnected from VaultConnect');
				this.isConnected = false;
				this.updateStatusBar('disconnected');
			});

			this.socket.on('subscribed', (data: { vault_id: string }) => {
				logger.debug('Subscribed to vault:', data);
				new Notice('Subscribed to vault sync');
			});

			this.socket.on('sync_event', (data: SyncEventData) => {
				void (async () => {
					logger.debug('Received sync event:', data);
					await this.handleRemoteChange(data);
				})();
			});

			this.socket.on('conflict', (data: ConflictEventData) => {
				logger.debug('Conflict detected:', data);
				this.handleConflict(data);
			});

			this.socket.on('connect_error', (error: Error) => {
				logger.error('Connection error:', error);
				this.updateStatusBar('error');
				new Notice(`Connection error: ${error.message}`);
			});

			this.socket.on('heartbeat', (data: { timestamp: number }) => {
				logger.debug('Heartbeat:', data.timestamp);
			});

		} catch (error) {
			logger.error('Failed to connect:', error);
			new Notice(`Failed to connect: ${error.message}`);
			this.updateStatusBar('error');
		}
	}

	disconnect() {
		if (this.socket) {
			this.socket.disconnect();
			this.socket = null;
		}

		// Stop sync service
		if (this.syncService) {
			this.syncService.stop();
		}

		this.isConnected = false;
		this.updateStatusBar('disconnected');
		new Notice('Disconnected from vault connect');
	}

	/**
	 * Batch notifications to avoid notification spam during bulk operations
	 * Collects multiple operations of the same type and shows a single consolidated notification
	 */
	private batchNotification(operation: string, filePath: string): void {
		// Check if sync notifications are enabled
		if (!this.settings.notifyOnSync) {
			return;
		}

		const batch = this.notificationBatch.get(operation);

		if (batch) {
			// Add to existing batch and reset timeout
			batch.files.push(filePath);
			clearTimeout(batch.timeout);

			// Set new timeout to show notification
			batch.timeout = setTimeout(() => {
				this.showBatchedNotification(operation, batch.files);
				this.notificationBatch.delete(operation);
			}, this.BATCH_DELAY_MS);
		} else {
			// Create new batch
			const timeout = setTimeout(() => {
				const currentBatch = this.notificationBatch.get(operation);
				if (currentBatch) {
					this.showBatchedNotification(operation, currentBatch.files);
					this.notificationBatch.delete(operation);
				}
			}, this.BATCH_DELAY_MS);

			this.notificationBatch.set(operation, {
				files: [filePath],
				timeout
			});
		}
	}

	/**
	 * Show a consolidated notification for batched operations
	 */
	private showBatchedNotification(operation: string, files: string[]): void {
		const count = files.length;

		if (count === 1) {
			// Single file - show regular notification
			const operationLabels: Record<string, string> = {
				delete: 'deleted',
				create: 'created',
				update: 'updated',
				rename: 'renamed'
			};
			const label = operationLabels[operation] || operation;
			new Notice(`File ${label} from remote: ${files[0]}`);
		} else {
			// Multiple files - show batched notification
			const operationLabels: Record<string, string> = {
				delete: 'Deleted',
				create: 'Created',
				update: 'Updated',
				rename: 'Renamed'
			};
			const label = operationLabels[operation] || operation;
			new Notice(`${label} ${count} files from remote`);
		}
	}

	async handleRemoteChange(data: SyncEventData) {
		try {
			const { file_path, operation, device_id, old_path } = data;

			// Skip if change is from this device
			if (device_id === this.settings.deviceId) {
				logger.debug(`[VaultConnect] Skipping sync event from own device: ${file_path}`);
				return;
			}

			logger.debug(`[VaultConnect] Processing remote change for: ${file_path}, operation: ${operation}`);

			// Handle delete operation
			if (operation === 'delete') {
				const file = this.app.vault.getAbstractFileByPath(file_path);
				if (file instanceof TFile) {
					await this.app.fileManager.trashFile(file);

					// Batch notifications for multiple deletes
					this.batchNotification('delete', file_path);

					// Clean up sync state
					if (this.fileSyncService) {
						this.fileSyncService.clearSyncState(file_path);
					}
				} else {
					logger.debug(`[VaultConnect] File already deleted locally: ${file_path}`);
				}
				return;
			}

			// Handle rename operation
			if (operation === 'rename' && old_path) {
				const oldFile = this.app.vault.getAbstractFileByPath(old_path);
				if (oldFile instanceof TFile) {
					logger.debug(`[VaultConnect] Renaming file: ${old_path} -> ${file_path}`);
					await this.app.vault.rename(oldFile, file_path);

					// Batch notification for rename
					this.batchNotification('rename', `${old_path} → ${file_path}`);

					// Update sync state with new path
					if (this.fileSyncService) {
						await this.fileSyncService.handleFileRename(old_path, file_path);
					}
				} else {
					// Old file doesn't exist locally, treat as create
					logger.debug(`[VaultConnect] Old file not found, treating rename as create: ${file_path}`);
					if (this.fileSyncService) {
						const result = await this.fileSyncService.downloadFile(file_path);
						if (result.success) {
							this.batchNotification('create', file_path);
						}
					}
				}
				return;
			}

			// For create/update operations, check if we need to download
			if (this.fileSyncService) {
				const { hash: remoteHash } = data;

				// Check if file exists locally
				const localFile = this.app.vault.getAbstractFileByPath(file_path);

				if (localFile instanceof TFile && remoteHash) {
					// Compute local file hash
					const content = await this.app.vault.read(localFile);
					const localHash = await this.fileSyncService.computeHash(content);

					// If hashes match, skip download - file is already up to date
					if (localHash === remoteHash) {
						logger.debug(`[VaultConnect] Skipping download for ${file_path} - hash matches (${remoteHash.substring(0, 8)})`);
						// Update stored hash to prevent unnecessary uploads
						this.fileSyncService.updateFileHash(file_path, remoteHash);
						return;
					}

					logger.debug(`[VaultConnect] Hash mismatch for ${file_path}: local=${localHash.substring(0, 8)}, remote=${remoteHash.substring(0, 8)}`);
				}

				// Safe to download - either file doesn't exist locally, hash differs, or no local changes
				// Note: We don't need to ignore the file watcher because the hash-based check in
				// uploadFile() will prevent unnecessary re-uploads after download
				const result = await this.fileSyncService.downloadFile(file_path);
				if (result.success) {
					logger.debug(`[VaultConnect] Successfully synced remote change: ${file_path}`);

					// Batch notification for create/update
					const action = operation === 'create' ? 'create' : 'update';
					this.batchNotification(action, file_path);
				} else {
					logger.error(`[VaultConnect] Failed to sync remote change: ${file_path}`, result.error);
					new Notice(`Failed to sync remote change: ${result.error}`);
				}
			} else {
				logger.error(`[VaultConnect] FileSyncService not available to handle remote change`);
			}
		} catch (error) {
			logger.error('Error handling remote change:', error);
			new Notice(`Error syncing remote change: ${error.message}`);
		}
	}

	handleConflict(data: ConflictEventData) {
		const { file_path } = data;
		new Notice(`Conflict detected in ${file_path}. Please resolve manually.`, 10000);
		// TODO: Implement conflict resolution UI
	}

	async forceSyncAll() {
		if (!this.isConnected) {
			new Notice('Not connected to vault connect');
			return;
		}

		new Notice('Starting full sync...');
		const files = this.app.vault.getFiles(); // Changed from getMarkdownFiles() to getFiles()
		let synced = 0;

		for (const file of files) {
			if (this.shouldSyncFile(file)) {
				await this.syncFile(file, 'modify');
				synced++;
			}
		}

		new Notice(`Synced ${synced} files`);
	}

	/**
	 * Perform Smart Sync
	 */
	async performSmartSync(): Promise<void> {
		if (!this.isConnected) {
			new Notice('Not connected to vault connect');
			return;
		}

		if (!this.syncService) {
			new Notice('Sync service not initialized');
			return;
		}

		try {
			if (this.settings.notifyOnSync) {
				new Notice('Starting smart sync...');
			}
			const result = await this.syncService.smartSync();

			if (this.settings.notifyOnSync) {
				if (result.success) {
					new Notice(
						`Smart sync completed: ${result.filesUploaded} uploaded, ${result.filesDownloaded} downloaded`
					);
				} else {
					new Notice(
						`Smart sync completed with ${result.errors.length} error(s). Check sync log for details.`
					);
				}
			}
		} catch (error) {
			logger.error('Smart Sync error:', error);
			new Notice(`Smart sync failed: ${error.message}`);
		}
	}

	/**
	 * Perform Pull All
	 */
	async performPullAll(): Promise<void> {
		if (!this.isConnected) {
			new Notice('Not connected to vault connect');
			return;
		}

		if (!this.syncService) {
			new Notice('Sync service not initialized');
			return;
		}

		const confirmed = await showConfirmationModal(
			this.app,
			'Pull all will download all remote files and create conflict copies for any local differences. Continue?',
			{ title: 'Pull all', confirmText: 'Pull all', confirmClass: 'mod-warning' }
		);

		if (!confirmed) {
			return;
		}

		try {
			new Notice('Starting pull all...');
			const result = await this.syncService.pullAll();

			if (result.success) {
				new Notice(
					`Pull all completed: ${result.filesDownloaded} files downloaded`
				);
			} else {
				new Notice(
					`Pull all completed with ${result.errors.length} error(s). Check sync log for details.`
				);
			}
		} catch (error) {
			logger.error('Pull All error:', error);
			new Notice(`Pull all failed: ${error.message}`);
		}
	}

	/**
	 * Perform Push All
	 */
	async performPushAll(): Promise<void> {
		if (!this.isConnected) {
			new Notice('Not connected to vault connect');
			return;
		}

		if (!this.syncService) {
			new Notice('Sync service not initialized');
			return;
		}

		const confirmed = await showConfirmationModal(
			this.app,
			'Push all will upload all local files and overwrite remote versions. Continue?',
			{ title: 'Push all', confirmText: 'Push all', confirmClass: 'mod-warning' }
		);

		if (!confirmed) {
			return;
		}

		try {
			new Notice('Starting push all...');
			const result = await this.syncService.pushAll();

			if (result.success) {
				new Notice(
					`Push all completed: ${result.filesUploaded} files uploaded`
				);
			} else {
				new Notice(
					`Push all completed with ${result.errors.length} error(s). Check sync log for details.`
				);
			}
		} catch (error) {
			logger.error('Push All error:', error);
			new Notice(`Push all failed: ${error.message}`);
		}
	}

	/**
	 * Perform Force Sync
	 */
	async performForceSync(): Promise<void> {
		if (!this.isConnected) {
			new Notice('Not connected to vault connect');
			return;
		}

		if (!this.syncService) {
			new Notice('Sync service not initialized');
			return;
		}

		const confirmed = await showConfirmationModal(
			this.app,
			'Force sync will clear sync state and re-sync all files. Continue?',
			{ title: 'Force sync', confirmText: 'Force sync', confirmClass: 'mod-warning' }
		);

		if (!confirmed) {
			return;
		}

		try {
			if (this.settings.notifyOnSync) {
				new Notice('Starting force sync...');
			}
			const result = await this.syncService.forceSync();

			if (this.settings.notifyOnSync) {
				if (result.success) {
					new Notice(
						`Force sync completed: ${result.filesProcessed} files processed`
					);
				} else {
					new Notice(
						`Force sync completed with ${result.errors.length} error(s). Check sync log for details.`
					);
				}
			}
		} catch (error) {
			logger.error('Force Sync error:', error);
			new Notice(`Force sync failed: ${error.message}`);
		}
	}

	/**
	 * View Conflicts
	 */
	viewConflicts(): void {
		if (!this.conflictService) {
			new Notice('Conflict service not initialized');
			return;
		}

		const conflicts = this.conflictService.getConflicts();
		
		if (conflicts.length === 0) {
			new Notice('No conflicts to resolve');
			return;
		}

		// Open conflict resolution modal
		const modal = new ConflictResolutionModal(
			this.app,
			this.conflictService,
			() => {
				// Refresh callback
				logger.debug('Conflicts resolved');
			}
		);
		modal.open();
	}

	/**
	 * View Sync Log
	 */
	viewSyncLog(): void {
		if (!this.syncLogService) {
			new Notice('Sync log service not initialized');
			return;
		}

		const modal = new SyncLogModal(this.app, this.syncLogService);
		modal.open();
	}

	/**
	 * Show sync menu
	 */
	private showSyncMenu(evt: MouseEvent): void {
		const menu = new Menu();

		// Connection status
		menu.addItem((item) => {
			item
				.setTitle(this.isConnected ? '🟢 Connected' : '⚫ Disconnected')
				.setDisabled(true);
		});

		menu.addSeparator();

		// Connect/Disconnect
		if (this.isConnected) {
			menu.addItem((item) => {
				item
					.setTitle('Disconnect')
					.setIcon('plug-zap-off')
					.onClick(() => this.disconnect());
			});
		} else {
			menu.addItem((item) => {
				item
					.setTitle('Connect')
					.setIcon('plug-zap')
					.onClick(() => this.connect());
			});
		}

		menu.addSeparator();

		// Sync operations
		menu.addItem((item) => {
			item
				.setTitle('Smart sync')
				.setIcon('refresh-cw')
				.setDisabled(!this.isConnected)
				.onClick(() => this.performSmartSync());
		});

		menu.addItem((item) => {
			item
				.setTitle('Pull all')
				.setIcon('download')
				.setDisabled(!this.isConnected)
				.onClick(() => this.performPullAll());
		});

		menu.addItem((item) => {
			item
				.setTitle('Push all')
				.setIcon('upload')
				.setDisabled(!this.isConnected)
				.onClick(() => this.performPushAll());
		});

		menu.addItem((item) => {
			item
				.setTitle('Force sync')
				.setIcon('zap')
				.setDisabled(!this.isConnected)
				.onClick(() => this.performForceSync());
		});

		menu.addSeparator();

		// View options
		menu.addItem((item) => {
			const conflictCount = this.conflictService?.getConflictCount() || 0;
			item
				.setTitle(`View conflicts ${conflictCount > 0 ? `(${conflictCount})` : ''}`)
				.setIcon('alert-triangle')
				.onClick(() => this.viewConflicts());
		});

		menu.addItem((item) => {
			item
				.setTitle('View sync log')
				.setIcon('file-text')
				.onClick(() => this.viewSyncLog());
		});

		menu.showAtMouseEvent(evt);
	}

	showSyncStatus() {
		const status = this.isConnected ? 'Connected' : 'Disconnected';
		const vault = this.settings.vaultId || 'Not configured';
		new Notice(`VaultConnect Status: ${status}\nVault: ${vault}`, 5000);
	}

	updateStatusBar(status: 'connected' | 'disconnected' | 'syncing' | 'connecting' | 'error') {
		const icons = {
			connected: '🟢',
			disconnected: '⚫',
			syncing: '🔄',
			connecting: '🟡',
			error: '🔴'
		};

		const labels = {
			connected: 'VaultConnect: Connected',
			disconnected: 'VaultConnect: Disconnected',
			syncing: 'VaultConnect: Syncing...',
			connecting: 'VaultConnect: Connecting...',
			error: 'VaultConnect: Error'
		};

		// Add cross-tenant indicator if applicable
		let crossTenantIndicator = '';
		if (this.vaultService && status === 'connected') {
			const isCrossTenant = this.vaultService.isCrossTenantVault();
			const permission = this.vaultService.getCurrentVaultPermission();
			
			if (isCrossTenant) {
				if (permission === 'read') {
					crossTenantIndicator = ' 🔗👁️';
				} else if (permission === 'write') {
					crossTenantIndicator = ' 🔗✏️';
				} else {
					crossTenantIndicator = ' 🔗';
				}
			}
		}

		this.statusBarItem.setText(`${icons[status]} ${labels[status]}${crossTenantIndicator}`);
		this.updateRibbonIcon();
	}

	/**
	 * Update ribbon icon to reflect sync status
	 */
	updateRibbonIcon(): void {
		if (!this.ribbonIconEl) {
			return;
		}

		// Remove existing status classes
		this.ribbonIconEl.removeClass('vaultsync-connected');
		this.ribbonIconEl.removeClass('vaultsync-disconnected');
		this.ribbonIconEl.removeClass('vaultsync-syncing');
		this.ribbonIconEl.removeClass('vaultsync-error');

		// Add appropriate status class
		if (this.isSyncing) {
			this.ribbonIconEl.addClass('vaultsync-syncing');
			this.ribbonIconEl.setAttribute('aria-label', 'Vault connect: syncing...');
		} else if (this.isConnected) {
			this.ribbonIconEl.addClass('vaultsync-connected');
			const conflictCount = this.conflictService?.getConflictCount() || 0;
			const label = conflictCount > 0
				? `Vault connect: connected (${conflictCount} conflicts)`
				: 'Vault connect: connected';
			this.ribbonIconEl.setAttribute('aria-label', label);
		} else {
			this.ribbonIconEl.addClass('vaultsync-disconnected');
			this.ribbonIconEl.setAttribute('aria-label', 'Vault connect: disconnected');
		}
	}
}

class VaultSyncSettingTab extends PluginSettingTab {
	plugin: VaultSyncPlugin;

	constructor(app: App, plugin: VaultSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Vault connect')
			.setHeading();

		// API URL
		new Setting(containerEl)
			.setName('API url')
			.setDesc('Vault connect API server url')
			.addText(text => text
				.setPlaceholder('http://localhost:3001/v1')
				.setValue(this.plugin.settings.apiUrl)
				.onChange(async (value) => {
					this.plugin.settings.apiUrl = value;
					await this.plugin.saveSettings();
				}));

		// WebSocket URL
		new Setting(containerEl)
			.setName('WebSocket url')
			.setDesc('Vault connect WebSocket server url')
			.addText(text => text
				.setPlaceholder('http://localhost:3001')
				.setValue(this.plugin.settings.wsUrl)
				.onChange(async (value) => {
					this.plugin.settings.wsUrl = value;
					await this.plugin.saveSettings();
				}));

		// Authentication
		new Setting(containerEl)
			.setName('Authentication')
			.setDesc(this.plugin.settings.apiKey ? '🟢 Connected' : '⚫ Not connected')
			.addButton(button => {
				if (this.plugin.settings.apiKey) {
					button
						.setButtonText('Logout')
						.setWarning()
						.onClick(async () => {
							// Disconnect from vault if connected
							if (this.plugin.isConnected) {
								this.plugin.disconnect();
							}

							// Clear all authentication and sync state
							this.plugin.settings.apiKey = '';
							this.plugin.settings.apiKeyExpires = null;
							this.plugin.settings.vaultId = '';

							// Clear initial sync state from plugin data
							if (this.plugin.initialSyncService) {
								try {
									// Clear all initial sync states
									await this.plugin.initialSyncService['storage'].set('initialSyncStates', {});
								} catch (e) {
									logger.warn('Could not clear initial sync states:', e);
								}
							}

							// Clear file sync state
							const syncStateFile = `${this.plugin.manifest.dir}/.sync-state.json`;
							const adapter = this.plugin.app.vault.adapter;
							try {
								if (await adapter.exists(syncStateFile)) {
									await adapter.remove(syncStateFile);
								}
							} catch (e) {
								logger.warn('Could not clear sync state file:', e);
							}

							await this.plugin.saveSettings();
							new Notice('Logged out successfully. All sync state has been cleared.');
							this.display();
						});
				} else {
					button
						.setButtonText('Login')
						.setCta()
						.onClick(async () => {
							try {
								// Ensure clean state before login
								this.plugin.settings.apiKey = '';
								this.plugin.settings.apiKeyExpires = null;
								this.plugin.settings.vaultId = '';

								// Clear initial sync state from plugin data
								if (this.plugin.initialSyncService) {
									try {
										// Clear all initial sync states
										await this.plugin.initialSyncService['storage'].set('initialSyncStates', {});
									} catch (e) {
										console.warn('Could not clear initial sync states:', e);
									}
								}

								// Clear file sync state
								const syncStateFile = `${this.plugin.manifest.dir}/.sync-state.json`;
								const adapter = this.plugin.app.vault.adapter;
								try {
									if (await adapter.exists(syncStateFile)) {
										await adapter.remove(syncStateFile);
									}
								} catch (e) {
									console.warn('Could not clear sync state file:', e);
								}

								await this.plugin.saveSettings();

								// Show loading notice
								const loadingNotice = new Notice('Requesting authorization code...', 0);

								// Start device auth flow
								const deviceCodeResp = await requestUrl({
									url: `${this.plugin.settings.apiBaseURL}/auth/device/code`,
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({
										client_id: 'obsidian-plugin',
										scope: 'vault:read vault:write file:read file:write'
									})
								});

								if (deviceCodeResp.status !== 200) {
									throw new Error('Failed to request device code');
								}

								const deviceData = deviceCodeResp.json;
								loadingNotice.hide();

								// Show user code
								const modal = new Modal(this.app);
								modal.titleEl.setText('Authorize vault connect');
								const codeEl = modal.contentEl.createDiv({ cls: 'vaultconnect-auth-modal' });

								codeEl.createEl('p', { text: 'Enter this code in your browser:', cls: 'vaultconnect-auth-instruction' });

								const codeDisplay = codeEl.createDiv({ cls: 'vaultconnect-auth-code' });
								codeDisplay.setText(deviceData.user_code);

								const stepsEl = codeEl.createEl('p', { cls: 'vaultconnect-auth-steps' });
								stepsEl.createSpan({ text: '1. A browser window should open automatically' });
								stepsEl.createEl('br');
								stepsEl.createSpan({ text: '2. If not, click the button below' });
								stepsEl.createEl('br');
								stepsEl.createSpan({ text: '3. Enter the code and select token duration' });
								stepsEl.createEl('br');
								stepsEl.createSpan({ text: '4. Click "Authorize"' });

								const btnContainer = codeEl.createDiv({ cls: 'vaultconnect-auth-buttons' });
								const openBtn = btnContainer.createEl('button', { text: 'Open browser', cls: 'mod-cta' });
								openBtn.onclick = () => window.open(deviceData.verification_uri_complete, '_blank');

								const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
								cancelBtn.onclick = () => modal.close();

								const waitingEl = codeEl.createDiv({ cls: 'vaultconnect-auth-waiting' });
								waitingEl.createEl('p', { text: 'Waiting for authorization...' });

								// Open browser automatically
								window.open(deviceData.verification_uri_complete, '_blank');
								modal.open();

								// Poll for token
								const pollInterval = deviceData.interval * 1000;
								const expiresAt = Date.now() + deviceData.expires_in * 1000;
								let cancelled = false;

								modal.onClose = () => { cancelled = true; };

								const poll = async () => {
									if (cancelled || Date.now() >= expiresAt) {
										return;
									}

									try {
										const tokenResp = await requestUrl({
											url: `${this.plugin.settings.apiBaseURL}/auth/device/token`,
											method: 'POST',
											headers: { 'Content-Type': 'application/json' },
											body: JSON.stringify({ device_code: deviceData.device_code }),
											throw: false
										});

										if (tokenResp.status === 200) {
											const tokenData = tokenResp.json;
											this.plugin.settings.apiKey = tokenData.access_token;
											const expiresDate = new Date(Date.now() + tokenData.expires_in * 1000);
											this.plugin.settings.apiKeyExpires = expiresDate;
											await this.plugin.saveSettings();
											modal.close();
											new Notice('Successfully authorized!');
											this.display();
										} else {
											const error = tokenResp.json;
											if (error.error !== 'authorization_pending') {
												throw new Error(error.error_description || 'Authorization failed');
											}
											// Still pending, continue polling
											void setTimeout(() => { void poll(); }, pollInterval);
										}
									} catch (err) {
										modal.close();
										new Notice('Authorization failed: ' + err.message);
									}
								};

								// Start polling
								void setTimeout(() => { void poll(); }, pollInterval);

							} catch (err) {
								new Notice('Failed to start authorization: ' + err.message);
							}
						});
				}
			});

		// Vault Selection
		this.addVaultSelector(containerEl);

		// Device ID (read-only)
		new Setting(containerEl)
			.setName('Device ID')
			.setDesc('Unique identifier for this device')
			.addText(text => {
				text.setValue(this.plugin.settings.deviceId);
				text.inputEl.disabled = true;
			});

		// Auto Sync
		new Setting(containerEl)
			.setName('Auto sync')
			.setDesc('Automatically sync file changes')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
				}));

		// Excluded Folders
		const configDir = this.app.vault.configDir;
		new Setting(containerEl)
			.setName('Excluded folders')
			.setDesc('Folders to exclude from sync (comma-separated)')
			.addText(text => text
				.setPlaceholder(`${configDir}, .trash`)
				.setValue(this.plugin.settings.excludedFolders.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.excludedFolders = value
						.split(',')
						.map(f => f.trim())
						.filter(f => f.length > 0);
					await this.plugin.saveSettings();
				}));

		// Connection Controls
		new Setting(containerEl)
			.setName('Connection')
			.setHeading();

		new Setting(containerEl)
			.setName('Connection status')
			.setDesc(this.plugin.isConnected ? 'Connected' : 'Disconnected')
			.addButton(button => button
				.setButtonText(this.plugin.isConnected ? 'Disconnect' : 'Connect')
				.onClick(async () => {
					if (this.plugin.isConnected) {
						this.plugin.disconnect();
					} else {
						await this.plugin.connect();
					}
					this.display(); // Refresh settings
				}));

		new Setting(containerEl)
			.setName('Force sync all')
			.setDesc('Sync all files in the vault')
			.addButton(button => button
				.setButtonText('Sync all')
				.onClick(async () => {
					await this.plugin.forceSyncAll();
				}));

		// Log Level
		new Setting(containerEl)
			.setName('Logging')
			.setHeading();

		new Setting(containerEl)
			.setName('Log level')
			.setDesc('Control how much information is logged to the console')
			.addDropdown(dropdown => {
				// Add all log levels
				Object.entries(LOG_LEVEL_NAMES).forEach(([value, name]) => {
					const level = parseInt(value) as LogLevel;
					const description = LOG_LEVEL_DESCRIPTIONS[level];
					dropdown.addOption(value, `${name} - ${description}`);
				});
				
				dropdown
					.setValue(this.plugin.settings.logLevel.toString())
					.onChange(async (value) => {
						const level = parseInt(value) as LogLevel;
						this.plugin.settings.logLevel = level;
						await this.plugin.saveSettings();
						
						// Update logger immediately
						logger.setLevel(level);
						logger.info(`Log level changed to: ${LOG_LEVEL_NAMES[level]}`);
						
						new Notice(`Log level set to: ${LOG_LEVEL_NAMES[level]}`);
					});
			});

	}

	/**
	 * Add vault selector with refresh button
	 */
	private addVaultSelector(containerEl: HTMLElement): void {
		const vaultSetting = new Setting(containerEl)
			.setName('Vault')
			.setDesc('Select the vault to sync with');

		// Create container for dropdown and button
		const controlsContainer = vaultSetting.controlEl.createDiv({ cls: 'vaultconnect-vault-selector' });

		// Dropdown
		const dropdown = controlsContainer.createEl('select', { cls: 'dropdown vaultconnect-vault-dropdown' });

		// Refresh button
		const refreshButton = controlsContainer.createEl('button', { text: 'Refresh', cls: 'mod-cta vaultconnect-refresh-btn' });

		// Loading indicator
		const loadingEl = controlsContainer.createEl('span', { text: 'Loading...', cls: 'vaultconnect-loading' });

		// Load vaults function
		const loadVaults = async () => {
			if (!this.plugin.settings.apiKey) {
				dropdown.empty();
				dropdown.createEl('option', { text: 'Enter API key first', value: '' });
				dropdown.disabled = true;
				refreshButton.disabled = true;
				return;
			}

			try {
				loadingEl.addClass('is-visible');
				refreshButton.disabled = true;
				dropdown.disabled = true;

				// Fetch vaults using API client
				const vaults = await this.plugin.apiClient?.listVaults();

				dropdown.empty();
				
				if (!vaults || vaults.length === 0) {
					dropdown.createEl('option', { text: 'No vaults found', value: '' });
					new Notice('No vaults found. Create a vault in the web UI first.');
				} else {
					// Add placeholder option
					dropdown.createEl('option', { text: 'Select a vault...', value: '' });

					// Add vault options
					vaults.forEach((vault: VaultInfo) => {
						const option = dropdown.createEl('option', {
							text: `${vault.name} (${vault.file_count || 0} files)`,
							value: vault.vault_id
						});
						if (vault.vault_id === this.plugin.settings.vaultId) {
							option.selected = true;
						}
					});

					new Notice(`Found ${vaults.length} vault(s)`);
				}

				dropdown.disabled = false;
			} catch (error) {
				logger.error('Failed to load vaults:', error);
				dropdown.empty();
				dropdown.createEl('option', { text: 'Error loading vaults', value: '' });
				new Notice(`Failed to load vaults: ${error.message}`);
			} finally {
				loadingEl.removeClass('is-visible');
				refreshButton.disabled = false;
			}
		};

		// Dropdown change handler
		dropdown.addEventListener('change', () => {
			void (async () => {
				const selectedVaultId = dropdown.value;
				if (selectedVaultId) {
					logger.debug('[VaultConnect] Vault selected:', selectedVaultId);
					this.plugin.settings.vaultId = selectedVaultId;
					await this.plugin.saveSettings();
					logger.debug('[VaultConnect] Settings saved. Current vaultId:', this.plugin.settings.vaultId);
					new Notice(`Vault selected: ${selectedVaultId.substring(0, 8)}...\nDisconnect and reconnect to sync with this vault.`);
				}
			})();
		});

		// Refresh button handler
		refreshButton.addEventListener('click', () => {
			void (async () => {
				await loadVaults();
			})();
		});

		// Initial load
		if (this.plugin.settings.apiKey) {
			void loadVaults();
		} else {
			dropdown.createEl('option', { text: 'Enter API key first', value: '' });
			dropdown.disabled = true;
			refreshButton.disabled = true;
		}
	}
}
