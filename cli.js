#!/usr/bin/env node
/**
 * WAS Google Ads MCP (Maton edition) — CLI router
 *
 *   was-google-ads-mcp-maton           Start the MCP server (used by Claude Desktop via stdio).
 *   was-google-ads-mcp-maton auth      Connect with your Maton API key.
 *   was-google-ads-mcp-maton logout    Delete the saved credentials.
 *   was-google-ads-mcp-maton status    Show whether credentials are saved and when.
 *   was-google-ads-mcp-maton help      Show usage.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONFIG_FILE } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmd = (process.argv[2] || '').toLowerCase();

if (cmd === 'auth') {
  const { runAuthFlow } = await import(join(__dirname, 'auth.js'));
  try {
    await runAuthFlow();
    process.exit(0);
  } catch (err) {
    console.error('\nAuth failed:', err?.message || err);
    process.exit(1);
  }
} else if (cmd === 'logout') {
  const { deleteConfigFile } = await import(join(__dirname, 'auth.js'));
  const deleted = await deleteConfigFile();
  console.log(deleted ? `Removed ${CONFIG_FILE}` : 'No saved credentials to remove.');
  process.exit(0);
} else if (cmd === 'status') {
  const { readConfigFile } = await import(join(__dirname, 'auth.js'));
  const cfg = await readConfigFile();
  if (!cfg) {
    console.log('Not configured. Run `npx -y github:mnsmasum62786/was-google-ads-mcp-maton auth` to connect.');
  } else {
    console.log(`Config:              ${CONFIG_FILE}`);
    console.log(`Saved:               ${cfg.saved_at || '(unknown)'}`);
    console.log(`Maton API key:       ${cfg.maton_api_key ? cfg.maton_api_key.slice(0, 6) + '…' + cfg.maton_api_key.slice(-4) : '(missing)'}`);
    console.log(`Default MCC:         ${cfg.login_customer_id || '(none set — pass loginCustomerId per call)'}`);
    console.log(`Maton base URL:      ${cfg.base_url}`);
    console.log(`Google Ads API ver:  ${cfg.api_version}`);
  }
  process.exit(0);
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`
WAS Google Ads MCP (Maton edition) — CLI

Usage:
  npx -y github:mnsmasum62786/was-google-ads-mcp-maton            Start MCP server (stdio, used by Claude Desktop)
  npx -y github:mnsmasum62786/was-google-ads-mcp-maton auth       Connect / re-connect with a Maton API key
  npx -y github:mnsmasum62786/was-google-ads-mcp-maton status     Show saved config summary (redacted)
  npx -y github:mnsmasum62786/was-google-ads-mcp-maton logout     Delete saved credentials
  npx -y github:mnsmasum62786/was-google-ads-mcp-maton help       This message

Environment overrides (per-call, take precedence over saved config):
  MATON_API_KEY                    Your Maton API key
  MATON_BASE_URL                   Maton API base (default: https://api.maton.ai)
  GOOGLE_ADS_API_VERSION           v23 (default) — bump when Maton updates
  GOOGLE_ADS_LOGIN_CUSTOMER_ID     Default MCC ID for all calls (digits only)

Requires Node 18+.
`);
  process.exit(0);
} else {
  // Default: start the MCP stdio server
  await import(join(__dirname, 'server.js'));
}
