# Changelog

All notable changes to VaultConnect will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
