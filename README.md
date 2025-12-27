# VaultConnect for Obsidian

Real-time synchronization plugin for Obsidian that keeps your notes synchronized across all your devices through the VaultConnect platform.

## Features

### ✨ Core Sync Features
- **Real-time Sync** - Automatic synchronization as you type
- **Conflict Resolution** - Smart handling of concurrent edits
- **Selective Sync** - Choose which folders to sync
- **Version History** - Track and restore previous versions
- **Offline Mode** - Work offline and sync when reconnected

### 🚀 Advanced Features
- **Chunked Uploads** - Efficiently handles large files
- **Resume After Restart** - Continues interrupted uploads
- **Progress Tracking** - Visual feedback for sync operations
- **Bi-directional Sync** - Changes sync in both directions
- **File Validation** - Ensures data integrity

### 📱 Platform Support
- **Cross-Platform** - Works on Desktop, Mobile, and Tablet
- **Multi-Device** - Sync across unlimited devices
- **Cloud-Based** - Access your notes from anywhere

## Installation

### From Obsidian Community Plugins

1. Open **Settings** → **Community Plugins**
2. Click **Browse** and search for "VaultConnect"
3. Click **Install**
4. Enable the plugin

### Manual Installation

1. Download the latest release from [GitHub Releases](https://github.com/BenJaminBMorin/obsidian-vaultconnect/releases)
2. Extract the files to your vault's plugins folder: `<vault>/.obsidian/plugins/vaultconnect/`
3. Reload Obsidian
4. Enable the plugin in Settings → Community Plugins

## Quick Start

### 1. Create an Account

Visit [vaultconnect.io](https://vaultconnect.io) to create a free account or use your self-hosted instance.

### 2. Connect Your Vault

1. Open **Settings** → **VaultConnect**
2. Enter your **API URL** (e.g., `https://api.vaultconnect.io` or your self-hosted URL)
3. Click **Login** and authenticate
4. Select or create a vault to sync with

### 3. Configure Sync

- **Auto-Sync**: Enable to sync automatically (recommended)
- **Selective Sync**: Choose which folders to include/exclude
- **Conflict Resolution**: Set your preferred strategy
  - **Newer Wins**: Most recent change takes precedence
  - **Local Wins**: Keep local changes during conflicts
  - **Remote Wins**: Accept server changes during conflicts

### 4. Start Syncing

Your vault will begin syncing automatically. Monitor progress in the status bar.

## Usage

### Status Bar

The status bar shows your current sync status:
- 🟢 **Synced** - Everything is up to date
- 🟡 **Syncing** - Active synchronization in progress
- 🔴 **Error** - Sync issue (click for details)
- ⚫ **Offline** - No connection to server

### Commands

Access these commands via Command Palette (Ctrl/Cmd + P):

- **Sync Now** - Force immediate sync
- **View Sync Status** - Show detailed sync information
- **View Sync Log** - See sync history and errors
- **Configure Selective Sync** - Manage synced folders
- **Pause/Resume Sync** - Temporarily stop syncing
- **Reset Sync** - Clear local sync state

### Selective Sync

Control which folders sync to save bandwidth and storage:

1. Open Settings → VaultConnect → **Configure Selective Sync**
2. Use the tree view to select folders
3. Click **Save** to apply changes
4. Synced folders show a ✓, excluded folders show an ✗

### Conflict Resolution

When conflicts occur:

1. A notice appears with conflict details
2. Choose your resolution strategy:
   - Keep local version
   - Accept remote version
   - Merge changes (manual)
3. VaultConnect creates backup files for safety

### Version History

View and restore previous versions:

1. Right-click a file → **File Menu** → **VaultConnect: Version History**
2. Browse available versions with timestamps
3. Click **Restore** to revert to a previous version

## Configuration

### Basic Settings

| Setting | Description | Default |
|---------|-------------|---------|
| API URL | VaultConnect server address | - |
| Auto-Sync | Sync automatically | Enabled |
| Sync Interval | Polling interval for changes | 30 seconds |
| Show Notifications | Display sync notifications | Enabled |

### Advanced Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Max File Size | Maximum file size for sync | 100 MB |
| Chunk Size | Upload chunk size | 5 MB |
| Retry Attempts | Number of retry attempts | 3 |
| Timeout | Request timeout | 30 seconds |
| Debug Logging | Enable detailed logs | Disabled |

### Selective Sync

Configure which folders to sync:

```
✓ 📁 Daily Notes
✓ 📁 Projects
  ✗ 📁 Projects/Archive
✓ 📁 Templates
✗ 📁 Temp
```

## Troubleshooting

### Sync Not Working

1. **Check Connection**: Verify API URL is correct
2. **Check Authentication**: Ensure you're logged in
3. **Check Permissions**: Verify vault access permissions
4. **View Logs**: Open sync log for detailed errors

### Files Not Syncing

1. **Check File Size**: Files over max size won't sync
2. **Check Selective Sync**: Ensure folder is included
3. **Check File Type**: Some file types may be excluded
4. **Force Sync**: Use "Sync Now" command

### Conflicts

1. **Use Auto-Resolution**: Enable automatic conflict resolution
2. **Check Backups**: Conflicted versions saved to `.conflicts/`
3. **Manual Resolution**: Edit files to resolve manually
4. **Reset Sync**: Clear state and re-sync if needed

### Common Issues

**"Authentication Failed"**
- Re-login through plugin settings
- Check API URL is correct
- Verify account credentials

**"Network Error"**
- Check internet connection
- Verify API server is reachable
- Check firewall/proxy settings

**"Quota Exceeded"**
- Check account storage limits
- Delete unnecessary files
- Upgrade account plan

## Privacy & Security

### Data Handling
- **End-to-End Encryption** - Optional encryption for sensitive notes
- **Secure Transport** - All data sent over HTTPS
- **Access Control** - Fine-grained permissions
- **Data Ownership** - You own your data

### Self-Hosting
VaultConnect supports self-hosting for complete control:

1. Deploy VaultConnect server (see [docs](https://docs.vaultconnect.io))
2. Point plugin to your server URL
3. Manage your own data and backups

## Performance

### Optimization Tips

- **Selective Sync**: Exclude large media folders
- **File Size Limits**: Set appropriate limits
- **Sync Interval**: Increase for slower connections
- **Offline Mode**: Use when traveling

### Benchmarks

- **Small Vault** (<100 files): ~2-5 seconds
- **Medium Vault** (100-1000 files): ~10-30 seconds
- **Large Vault** (>1000 files): ~1-3 minutes

*Initial sync times. Incremental syncs are much faster.*

## Roadmap

### Planned Features
- [ ] End-to-end encryption
- [ ] Collaborative editing
- [ ] Mobile optimization
- [ ] Plugin API for extensions
- [ ] Advanced conflict resolution
- [ ] Delta sync (only changed portions)

## Support

### Documentation
- [User Guide](USER_GUIDE.md)
- [FAQ](FAQ.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [API Reference](API_REFERENCE.md)

### Community
- [Discord Server](https://discord.gg/vaultconnect)
- [GitHub Discussions](https://github.com/BenJaminBMorin/obsidian-vaultconnect/discussions)
- [Twitter](https://twitter.com/vaultconnect)

### Issues
Report bugs or request features on [GitHub Issues](https://github.com/BenJaminBMorin/obsidian-vaultconnect/issues)

## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/BenJaminBMorin/obsidian-vaultconnect.git
cd obsidian-vaultconnect

# Install dependencies
npm install

# Build the plugin
npm run build

# Development with hot reload
npm run dev
```

### Testing

```bash
# Run tests
npm test

# Run with coverage
npm test:coverage

# Watch mode
npm test:watch
```

### Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- Built with [Obsidian API](https://github.com/obsidianmd/obsidian-api)
- Sync powered by [VaultConnect Platform](https://vaultconnect.io)
- Conflict resolution using [Yjs](https://github.com/yjs/yjs)

## Links

- **Homepage**: [vaultconnect.io](https://vaultconnect.io)
- **Documentation**: [docs.vaultconnect.io](https://docs.vaultconnect.io)
- **GitHub**: [github.com/BenJaminBMorin/obsidian-vaultconnect](https://github.com/BenJaminBMorin/obsidian-vaultconnect)
- **Support**: [support@vaultconnect.io](mailto:support@vaultconnect.io)

---

**Made with ❤️ for the Obsidian community**
