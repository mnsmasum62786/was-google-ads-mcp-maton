/**
 * Interactive setup for was-google-ads-mcp-maton.
 *
 * Asks for:
 *   - Maton API key (required)
 *   - Default MCC login_customer_id (optional — can be overridden per call)
 *
 * Then verifies the key works by calling listAccessibleCustomers through Maton.
 * Saves to ~/.was-google-ads-mcp-maton/config.json with mode 0600.
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_MATON_BASE_URL, DEFAULT_API_VERSION } from './config.js';

function prompt(question, opts = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve((answer || '').trim() || opts.default || '');
    });
  });
}

const cleanCid = (v) => v == null ? '' : String(v).replace(/[^0-9]/g, '');

export async function readConfigFile() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch { return null; }
}

export async function deleteConfigFile() {
  try {
    if (existsSync(CONFIG_FILE)) { unlinkSync(CONFIG_FILE); return true; }
  } catch {}
  return false;
}

async function verifyMatonKey({ apiKey, baseUrl, apiVersion, loginCustomerId }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/google-ads/${apiVersion}/customers:listAccessibleCustomers`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const errMsg = body?.error?.message || body?.message || `HTTP ${res.status}`;
    throw new Error(`Maton probe failed: ${errMsg}`);
  }
  return body;
}

export async function runAuthFlow() {
  console.log('\nWAS Google Ads MCP — Maton edition');
  console.log('─'.repeat(60));
  console.log('You will need a Maton API key. Get one free at https://www.maton.ai/');
  console.log('  1. Sign up / log in');
  console.log('  2. Connect your Google Ads account (one-click OAuth)');
  console.log('  3. Copy your API key from Settings → API Keys');
  console.log('');

  const apiKey = await prompt('Paste your Maton API key: ');
  if (!apiKey) { console.error('Aborted — no API key provided.'); process.exit(1); }

  const lcidRaw = await prompt('Default MCC login_customer_id (optional, digits only — press Enter to skip): ');
  const loginCustomerId = cleanCid(lcidRaw) || null;

  const baseUrl = process.env.MATON_BASE_URL || DEFAULT_MATON_BASE_URL;
  const apiVersion = process.env.GOOGLE_ADS_API_VERSION || DEFAULT_API_VERSION;

  console.log('\nVerifying key against Maton…');
  let probe;
  try {
    probe = await verifyMatonKey({ apiKey, baseUrl, apiVersion, loginCustomerId });
  } catch (err) {
    console.error(`\nVerification failed: ${err.message}`);
    console.error('\nNothing was saved. Common causes:');
    console.error('  - API key wrong or not yet activated in Maton dashboard');
    console.error('  - Google Ads account not connected in Maton');
    console.error('  - Maton\'s current Google Ads API version differs from ' + apiVersion);
    process.exit(1);
  }

  const count = Array.isArray(probe?.resourceNames) ? probe.resourceNames.length : 0;
  console.log(`✓ Key works. ${count} accessible customer(s) via Maton.`);
  if (count === 0) {
    console.log('  Note: no customers returned. Confirm your Google Ads account is fully connected in Maton.');
  }

  const record = {
    maton_api_key: apiKey,
    login_customer_id: loginCustomerId || null,
    base_url: baseUrl,
    api_version: apiVersion,
    saved_at: new Date().toISOString(),
  };

  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    chmodSync(CONFIG_DIR, 0o700);
  } catch {}

  writeFileSync(CONFIG_FILE, JSON.stringify(record, null, 2), { mode: 0o600 });
  try { chmodSync(CONFIG_FILE, 0o600); } catch {}

  console.log(`\n✓ Saved to ${CONFIG_FILE} (mode 0600).`);
  console.log('\nNext step — add to Claude Desktop config:\n');
  console.log('  Mac:     ~/Library/Application Support/Claude/claude_desktop_config.json');
  console.log('  Windows: %APPDATA%\\Claude\\claude_desktop_config.json');
  console.log('');
  console.log(JSON.stringify({
    mcpServers: {
      'WAS Google Ads MCP (Maton)': {
        command: 'npx',
        args: ['-y', 'github:mnsmasum62786/was-google-ads-mcp-maton'],
      },
    },
  }, null, 2));
  console.log('\nRestart Claude Desktop, then ask: "Run ads_list_accessible_customers."\n');
}
