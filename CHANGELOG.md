# Changelog

All notable changes to VaultConnect will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.34] - 2026-05-05

### Fixed
- **Force Sync now actually downloads files the server reports as missing.** v1.1.33's per-device inventory ack populated the `pendingDownloads` queue with files this device was missing, but `drainPendingDownloads` only ran from the periodic `performSyncCheck` — not from `smartSync` directly. Force Sync (which calls smartSync) would queue 600+ files and then return without downloading any of them, leaving the user staring at an empty file browser until either the next 2-minute periodic check fired or they reopened Obsidian. `smartSync` now drains the queue at the end of every run, so Force Sync brings everything local in one pass.
- **Bulk-add to `pendingDownloads` no longer triggers N separate state-saves.** Adding 600 paths previously meant 600 sequential `saveSyncState` writes, which is slow on iOS storage. New `addPendingDownloads` (plural) takes an iterable and saves once. The inventory-reconcile path now uses it.

## [1.1.33] - 2026-05-05

### Added
- **Per-device delivery acknowledgments — sync layer is now self-healing.** After every smart sync, the plugin POSTs its current local file inventory (path + hash for everything on disk) to a new server endpoint. Server compares against truth and returns the delta: which files this device is missing or has at the wrong hash. The plugin queues those into the existing `pendingDownloads` queue, which the next drain pass brings local — closing the loop on the entire class of "file exists on the server, never made it to my device" bugs. Server-side response also flags files the device claims to have but the server doesn't (likely a sync-loop bug worth investigating).

## [1.1.32] - 2026-05-05

### Added
- **`X-Device-Id` and `X-Device-Name` headers on every authenticated REST request.** The plugin already kept a stable `deviceId` in settings (used by the WebSocket layer); now it propagates that ID plus a friendly device-type label (`iPhone`, `Mac`, `Windows`, `Android`, `iPad`, etc., derived from Obsidian's `Platform` flags) through the JSON, HEAD, and chunked-upload paths. Server uses these to attribute activity per device in structured logs and the per-tenant `devices` table — so "is this Mac fetching the file or iPhone?" becomes greppable instead of a guessing game during sync debugging.

## [1.1.31] - 2026-05-05

### Fixed
- **Silent download-failure loop on iOS resolved.** `vault.create` was throwing `"File already exists"` for paths that `getAbstractFileByPath` had reported as empty moments earlier — an iOS-specific vault-adapter index inconsistency. The previous catch handler treated this as success, which left the file unwritten *and* with no sync-state update, so the next sync cycle re-discovered the same drift and re-downloaded the same files indefinitely (visible only as repeated `getFileByPath` traffic on the server). The download path now (a) checks `vault.getFiles()` (the canonical enumerable list) when `vault.create` reports a phantom existence and switches to `vault.modify` on the existing reference, and (b) surfaces a real error if neither lookup finds the file — instead of returning success.

### Added
- **Stuck-path notifications.** `drainPendingDownloads` now tracks consecutive failures per path. After 3 retries on the same path, the user sees a one-shot `Notice` with the path and last error message, so failures are visible on the device without having to read the dev console. The counter resets on the first successful download.

## [1.1.30] - 2026-05-05

### Fixed
- **Drift no longer gets permanently masked.** Previously, when an incremental sync detected files on the server that were missing locally but the active mode/auto-sync settings prevented an immediate download, the plugin still advanced its `lastSyncTimestamp` past those files — silently losing them until the user noticed and ran Force Sync. Drift is now persisted to a durable `pendingDownloads` queue (survives restarts, mode changes, and process kills mid-download), the queue is drained on every sync cycle until empty, and `lastSyncTimestamp` is held back until the queue is empty so any failure becomes an automatic retry rather than a permanent loss.

### Added
- **"Reconcile from server" command and settings button.** Stronger than Force Sync: clears the locally-deleted set and the pending-downloads queue in addition to file hashes/timestamps, then runs a full smart sync. Use this when files exist on the server but won't sync down even with Force Sync — typically caused by stale entries in the locally-deleted set from older sync cycles.

## [1.1.29] - 2026-05-01

### Fixed
- **Mobile sync no longer requires a force-sync after foregrounding the app.** Mobile Obsidian suspends JS while backgrounded, so the 2-minute periodic sync timer didn't fire and the user saw stale state until they manually triggered a sync. `SyncService` now listens for `visibilitychange` and runs a catch-up sync check (rate-limited to once per 30s) whenever the document becomes visible again.
- **Stale local copies are no longer re-uploaded after server-side deletions.** When another device deletes a file via Claude/MCP, this client's pending file-watcher events and `Push All` operations could resurrect that file. Both upload paths now consult a server-tombstone cache (refreshed lazily, with a 60s TTL) before uploading: if the local file's `mtime` predates the tombstone, the local copy is treated as stale and removed locally instead of being uploaded.

## [1.1.28] - 2026-04-30

### Fixed
- **Chunked uploads no longer fail with `MulterError: Unexpected field`** — the plugin was posting each chunk under multipart field name `file`, but the backend's `/v1/vaults/:id/files/upload/chunk` endpoint expects `chunk` (matching the web UI's `useChunkedUpload`). Switched the field name in `APIClient.uploadChunk` so the multer middleware accepts the request. The backend currently accepts both names as a compatibility shim; a future server release will tighten back to `chunk`-only.

## [1.1.27] - 2026-04-30

### Fixed
- **Offline conflict records now store the actual local hash** — `OfflineSyncService.storeConflict` was copying the remote hash into the `localHash` field, making the two hashes always match in the resulting record. Now reads the local file via the binary-aware path used elsewhere and computes its real hash. (P6)
- **Offline service event listeners are now cleaned up** — `OfflineQueueService` and `OfflineSyncService` subscribed to `OFFLINE_MODE_CHANGED` without capturing unsubscribe handles. On plugin reload these would have leaked. Both now track and run cleanups in `destroy()`. (P16)

### Changed
- **Dead code removed** — pruned ~12,400 lines across 34 files unreachable from `main.ts`: the unused native-WebSocket subgraph (presence, reconnection, etc.), Yjs/collaboration scaffolding, the unused offline-mode subgraph, several unwired UI modals, and unused utility modules. No user-facing behavior changes.

### Internal
- Wired up Jest properly with ts-jest so the test suite actually runs (it had no config and was failing to parse `.ts` imports). Updated stale fixtures. 151 tests pass.

## [1.1.26] - 2026-02-28

### Fixed
- **Folder renames now sync correctly** — previously, renaming a folder in Obsidian was silently ignored (only `TFile` was handled). Now all child files are enqueued as individual server-side renames, preserving file IDs and version history.

## [1.1.25] - 2026-02-28

### Fixed
- **File renames now use server-side rename API** — renames use `PUT /files/:fileId` with `newPath` instead of delete + create. This preserves file_id, version history, and all metadata. No tombstone is created, so other clients see a clean rename instead of a delete + re-download cycle.
- **Queue deduplication no longer swallows renames** — if a user edits a file immediately after renaming, the modify is merged into the pending rename operation instead of replacing it. This prevents orphaning the old file on the server.

## [1.1.24] - 2026-02-28

### Fixed
- **Force sync no longer re-uploads deleted files** — `clearAllSyncState()` now preserves the locally-deleted tracking set, so files that were deleted on the server (via tombstones) are not treated as "new local files" and re-uploaded during a force sync.
- **Force sync uses 30-day tombstone lookback** — `lastSyncTimestamp` is cleared on force sync so `smartSync()` always queries the full 30-day window of server-side deletions, catching all tombstones regardless of how stale the last sync was.
- **Tombstone fetch errors now logged** — previously, failures to fetch server deletions were silently swallowed. Now logged as warnings for easier debugging.

## [1.1.23] - 2026-02-28

### Added
- **Folder-level deletion tracking** — when a folder is deleted on the server, one tombstone record covers the entire subtree. The plugin uses prefix matching to delete all local files under that path, plus cleans up the empty folder. Much more efficient than N individual file tombstones.

### Fixed
- Both `smartSync()` and incremental sync now handle folder tombstones alongside file tombstones, preventing re-upload of files in deleted folders.

## [1.1.22] - 2026-02-27

### Fixed
- **Incremental sync now checks for server-side deletions** — previously, files deleted on the server were only detected during a full smart sync (manual trigger). Now every 2-minute incremental check also queries the `/deletions` endpoint, so server-side deletions propagate to all devices within minutes.
- **Periodic full sync every ~30 minutes** — every 15th incremental check triggers a full smart sync to catch edge cases (network hiccups, missed deletion events, etc.).

## [1.1.21] - 2026-02-26

### Fixed
- Server-side deletion tracking — `smartSync()` now fetches tombstone records from the server and deletes local copies of files that were removed remotely, preventing re-upload of deleted files.
- False conflicts for previously untracked binary files (images, PDFs, etc.) on first sync.
- Binary files re-downloaded every sync cycle due to hash mismatch.

## [1.1.20] - 2026-02-25

### Fixed
- Sync reliability — added mutex to prevent concurrent sync runs, fixed download retry loop, resolved binary file conflict detection, added offline operation queue.
- Binary file hash mismatch in `hasLocalChanges` causing unnecessary uploads.
- API endpoint mismatches with current backend after backend refactoring.
- Immediate auth detection when returning from browser (OAuth flow).
- Medium severity items — sync reliability, resource cleanup, error handling.

### Changed
- Removed dead code — unused methods, debug logs, example files.

## [1.0.0] - 2024-10-26

### Added

#### Core Features
- API key-based authentication with secure storage
- Multiple sync modes: Smart Sync, Pull All, Push All, Manual
- Real-time collaborative editing using Yjs CRDT
- Intelligent conflict detection and resolution
- Offline mode with automatic queue synchronization
- Selective sync with folder inclusion/exclusion
- Delta sync for large files (>1MB)
- Batch operations for improved performance

#### User Interface
- Comprehensive settings panel with all configuration options
- Status bar integration with real-time sync status
- Ribbon icon with quick access menu
- Conflict resolution modal with side-by-side diff viewer
- Active users sidebar panel
- Sync log viewer with filtering and search
- Error log modal with detailed error tracking
- Progress notifications for long operations

#### Collaboration Features
- Live cursor and selection tracking
- Typing indicators
- Presence awareness (active/away status)
- User join/leave notifications
- Recent activity view
- Collaboration metadata (last editor, timestamps)
- Active users list with current file tracking

#### Performance Optimizations
- Efficient caching system for metadata and file hashes
- Request batching to reduce network overhead
- Concurrent upload limiting (5 files)
- Debouncing for rapid file changes
- Memory-efficient handling of large vaults (10,000+ files)
- Optimized change detection (< 500ms)

#### Security Features
- HTTPS/WSS for all communications
- Encrypted API key storage
- XSS prevention with content sanitization
- Path traversal protection
- Input validation for all user inputs
- Secure error handling (no sensitive data in logs)
- Rate limiting utilities
- Security audit utilities

#### Documentation
- Complete user guide
- Setup and installation guide
- Developer guide for contributors
- Troubleshooting guide
- FAQ document
- API reference
- Architecture documentation
- Manual testing guide
- Performance testing guide
- Security audit report

#### Testing
- Comprehensive unit test suite
- Integration tests for major workflows
- Performance benchmarks
- Security testing utilities
- Manual testing procedures

### Changed
- N/A (Initial release)

### Deprecated
- N/A (Initial release)

### Removed
- N/A (Initial release)

### Fixed
- N/A (Initial release)

### Security
- Completed comprehensive security audit
- Implemented all OWASP Top 10 protections
- No known vulnerabilities

## Version History

### [1.0.0] - 2024-10-26
Initial public release of VaultConnect for Obsidian.

---

## Release Notes Format

Each release includes:
- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Features that will be removed
- **Removed**: Features that were removed
- **Fixed**: Bug fixes
- **Security**: Security improvements

## Versioning

VaultConnect follows [Semantic Versioning](https://semver.org/):

- **MAJOR** version (1.x.x): Incompatible API changes
- **MINOR** version (x.1.x): New features, backward compatible
- **PATCH** version (x.x.1): Bug fixes, backward compatible

## Support

For questions or issues:
- GitHub Issues: https://github.com/vaultsync/obsidian-vaultsync/issues
- Documentation: https://docs.vaultsync.io
- Email: support@vaultsync.io

## Links

- [Homepage](https://vaultsync.io)
- [Documentation](https://docs.vaultsync.io)
- [GitHub Repository](https://github.com/vaultsync/obsidian-vaultsync)
- [Community Forum](https://community.vaultsync.io)

---

**Note**: This changelog is maintained by the VaultConnect development team. All notable changes are documented here for transparency and user awareness.
