/**
 * Debug script to check vault ID usage
 * Add this to your plugin's console to debug vault ID issues
 */

export function debugVaultId(plugin: any) {
  console.debug('='.repeat(60));
  console.debug('VAULT ID DEBUG INFO');
  console.debug('='.repeat(60));

  console.debug('\n📋 Settings:');
  console.debug('  vaultId:', plugin.settings.vaultId);
  console.debug('  selectedVaultId:', plugin.settings.selectedVaultId);
  console.debug('  apiKey:', plugin.settings.apiKey ? `${plugin.settings.apiKey.substring(0, 10)}...` : 'NOT SET');
  console.debug('  apiUrl:', plugin.settings.apiUrl);

  console.debug('\n🔧 Services:');
  console.debug('  syncService.vaultId:', plugin.syncService?.vaultId || 'NOT INITIALIZED');
  console.debug('  conflictService.vaultId:', plugin.conflictService?.vaultId || 'NOT INITIALIZED');
  console.debug('  apiClient:', plugin.apiClient ? 'INITIALIZED' : 'NOT INITIALIZED');

  console.debug('\n🔌 Connection:');
  console.debug('  isConnected:', plugin.isConnected);
  console.debug('  socket:', plugin.socket ? 'CONNECTED' : 'NOT CONNECTED');

  console.debug('\n💾 Storage:');
  const data = plugin.loadData();
  data.then((d: any) => {
    console.debug('  Saved vaultId:', d?.vaultId);
    console.debug('  Saved selectedVaultId:', d?.selectedVaultId);
  });

  console.debug('\n' + '='.repeat(60));
  console.debug('To use: Copy this script and run debugVaultId(app.plugins.plugins["vaultbridge"])');
  console.debug('='.repeat(60));
}

// Make it available globally for console debugging
if (typeof window !== 'undefined') {
  (window as any).debugVaultId = debugVaultId;
}
