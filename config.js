/**
 * Config paths + defaults for was-google-ads-mcp-maton.
 *
 * Credentials live in ~/.was-google-ads-mcp-maton/config.json (mode 0600).
 * See auth.js for how they're written, server.js for how they're read.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR = join(homedir(), '.was-google-ads-mcp-maton');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

// Maton public API — proxies to googleads.googleapis.com/v{version}/...
// See https://github.com/maton-ai/api-gateway-skill/blob/main/references/google-ads/README.md
export const DEFAULT_MATON_BASE_URL = 'https://api.maton.ai';

// Google Ads API version Maton currently proxies. Bump this when Maton updates.
// See Maton's release notes / Discord for the latest supported version.
export const DEFAULT_API_VERSION = 'v23';
