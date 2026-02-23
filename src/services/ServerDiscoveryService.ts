import { requestUrl } from 'obsidian';
import { logger } from '../utils/logger';

export interface ServerConfig {
  apiUrl: string;
  webUiUrl: string;
  wsUrl: string;
  googleOAuthEnabled: boolean;
  version: string;
}

/**
 * Discovers the full server configuration from a user-entered URL.
 *
 * Discovery cascade:
 * 1. Try `{url}/v1/system/config` (user entered the API URL directly)
 * 2. Try `{baseUrl}/v1/system/config` (strip any path, treat as API base)
 * 3. Try `https://api.{hostname}/v1/system/config` (convention: prepend api. subdomain to web UI hostname)
 */
export class ServerDiscoveryService {
  private readonly TIMEOUT_MS = 5000;
  private readonly CONFIG_PATH = '/v1/system/config';

  async discover(userUrl: string): Promise<ServerConfig> {
    const url = userUrl.trim().replace(/\/+$/, ''); // strip trailing slashes

    if (!url) {
      throw new Error('Please enter a server URL');
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid URL format. Please enter a valid URL (e.g. https://app.vaultsync.morinclan.com)');
    }

    const attempts: string[] = [];

    // Attempt 1: User-entered URL directly (maybe they entered the API URL)
    const attempt1 = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    attempts.push(attempt1);
    logger.debug(`[ServerDiscovery] Attempt 1: ${attempt1}${this.CONFIG_PATH}`);
    const result1 = await this.tryUrl(attempt1);
    if (result1) return result1;

    // Attempt 2: Just the origin (strip any path the user included)
    if (parsed.pathname && parsed.pathname !== '/') {
      const attempt2 = parsed.origin;
      attempts.push(attempt2);
      logger.debug(`[ServerDiscovery] Attempt 2: ${attempt2}${this.CONFIG_PATH}`);
      const result2 = await this.tryUrl(attempt2);
      if (result2) return result2;
    }

    // Attempt 3: Prepend 'api.' subdomain (convention for web UI → API)
    const hostname = parsed.hostname;
    if (!hostname.startsWith('api.')) {
      const apiHostname = `api.${hostname}`;
      const attempt3 = `${parsed.protocol}//${apiHostname}`;
      attempts.push(attempt3);
      logger.debug(`[ServerDiscovery] Attempt 3: ${attempt3}${this.CONFIG_PATH}`);
      const result3 = await this.tryUrl(attempt3);
      if (result3) return result3;
    }

    throw new Error(
      `Could not discover server configuration. Tried:\n${attempts.map(a => `  ${a}${this.CONFIG_PATH}`).join('\n')}\n\nPlease check the URL and ensure the server is running.`
    );
  }

  private async tryUrl(baseUrl: string): Promise<ServerConfig | null> {
    try {
      const response = await requestUrl({
        url: `${baseUrl}${this.CONFIG_PATH}`,
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        throw: false,
      });

      if (response.status !== 200) {
        logger.debug(`[ServerDiscovery] ${baseUrl}${this.CONFIG_PATH} returned ${response.status}`);
        return null;
      }

      const data = response.json;

      // Validate that we got the expected shape
      if (!data || typeof data !== 'object') {
        return null;
      }

      // The backend may return the config in a wrapper or directly
      const config = data.data || data;

      const apiUrl = config.apiUrl || config.api_url || baseUrl;
      const webUiUrl = config.webUiUrl || config.web_ui_url || '';
      const wsUrl = config.wsUrl || config.ws_url || apiUrl; // Default WS to same as API
      const googleOAuthEnabled = config.googleOAuthEnabled ?? config.google_oauth_enabled ?? false;
      const version = config.version || 'unknown';

      // Ensure apiUrl includes the /v1 prefix since the plugin expects it
      const normalizedApiUrl = apiUrl.replace(/\/+$/, '');
      const apiUrlWithVersion = normalizedApiUrl.endsWith('/v1') ? normalizedApiUrl : `${normalizedApiUrl}/v1`;

      return {
        apiUrl: apiUrlWithVersion,
        webUiUrl: webUiUrl.replace(/\/+$/, ''),
        wsUrl: wsUrl.replace(/\/+$/, ''),
        googleOAuthEnabled,
        version,
      };
    } catch (error) {
      logger.debug(`[ServerDiscovery] Failed to reach ${baseUrl}${this.CONFIG_PATH}:`, error);
      return null;
    }
  }
}
