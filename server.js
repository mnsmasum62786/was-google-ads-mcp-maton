#!/usr/bin/env node
/**
 * WAS Google Ads MCP — Maton-backed edition (stdio server).
 *
 * 19 tools covering the full Google Ads API surface, routed through Maton's API
 * gateway instead of calling google-ads-api directly. All tool schemas + names
 * match the original was-google-ads-mcp so agents and prompts work identically.
 *
 * Auth model:
 *   - Single Maton API key (Bearer token). Maton injects Google's OAuth + developer
 *     token headers on the server side. No Google Cloud project, no OAuth
 *     Playground, no developer token application.
 *
 * Transport:
 *   - fetch() against https://api.maton.ai/google-ads/v{version}/customers/...
 *   - login-customer-id passed as HTTP header (per Google Ads REST spec)
 *
 * Read the Maton Google Ads reference for endpoint shapes:
 *   https://github.com/maton-ai/api-gateway-skill/blob/main/references/google-ads/README.md
 */

import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CONFIG_FILE, DEFAULT_MATON_BASE_URL, DEFAULT_API_VERSION } from './config.js';

// ─── credentials ──────────────────────────────────────────────────────────────

let saved = {};
try { saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { /* config missing — handled below */ }

const MATON_API_KEY = process.env.MATON_API_KEY || saved.maton_api_key;
const MATON_BASE_URL = (process.env.MATON_BASE_URL || saved.base_url || DEFAULT_MATON_BASE_URL).replace(/\/+$/, '');
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || saved.api_version || DEFAULT_API_VERSION;
const LOGIN_CUSTOMER_ID = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || saved.login_customer_id;

if (!MATON_API_KEY) {
  console.error(
    'WAS Google Ads MCP (Maton edition) — not configured yet.\n\n' +
    'First-time setup: open a terminal and run\n\n' +
    '    npx -y github:mnsmasum62786/was-google-ads-mcp-maton auth\n\n' +
    'You will be asked for:\n' +
    '  - Your Maton API key (get one free at https://www.maton.ai/)\n' +
    '  - Optional: default MCC login_customer_id\n\n' +
    'After that, restart Claude Desktop.\n' +
    'Config file: ' + CONFIG_FILE
  );
  process.exit(1);
}

const cleanCid = (v) => v == null ? null : String(v).replace(/[^0-9]/g, '');
const DEFAULT_LOGIN_CUSTOMER_ID = cleanCid(LOGIN_CUSTOMER_ID) || null;

// ─── low-level HTTP client (Maton passthrough) ────────────────────────────────

/**
 * Call a Google Ads REST endpoint via Maton.
 * @param {string} method 'GET' | 'POST'
 * @param {string} path e.g. `/customers/1234567890/googleAds:search` — will be prefixed with /google-ads/v23
 * @param {object|null} body JSON body for POST, ignored for GET
 * @param {string|null} loginCustomerId per-call override; falls back to DEFAULT_LOGIN_CUSTOMER_ID
 */
async function ads(method, path, body, loginCustomerId) {
  const url = `${MATON_BASE_URL}/google-ads/${API_VERSION}${path}`;
  const lcid = loginCustomerId ? cleanCid(loginCustomerId) : DEFAULT_LOGIN_CUSTOMER_ID;
  const headers = {
    'Authorization': `Bearer ${MATON_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (lcid) headers['login-customer-id'] = lcid;

  const init = { method, headers };
  if (body != null && method !== 'GET') init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }

  if (!res.ok) {
    const err = new Error(parsed?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = parsed;
    err.gaqlPath = path;
    throw err;
  }
  return parsed;
}

// ─── response wrappers ────────────────────────────────────────────────────────

function asTextResult(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const MAX = 60000;
  if (text.length > MAX) {
    return { content: [{ type: 'text', text: text.slice(0, MAX) + `\n\n... [truncated ${text.length - MAX} chars; narrow your query]` }] };
  }
  return { content: [{ type: 'text', text }] };
}

/**
 * Decode a Google Ads REST error response into a clean payload where
 * error_class + error_code + message are visible at the top level.
 *
 * REST GoogleAdsFailure shape (from Google's response details):
 *   {
 *     "error": {
 *       "code": 400,
 *       "message": "...",
 *       "status": "INVALID_ARGUMENT",
 *       "details": [{
 *         "@type": "type.googleapis.com/google.ads.googleads.vXX.errors.GoogleAdsFailure",
 *         "errors": [{
 *           "errorCode": { "authorizationError": "USER_PERMISSION_DENIED" },
 *           "message": "...", "trigger": {...}, "location": {...}
 *         }],
 *         "requestId": "..."
 *       }]
 *     }
 *   }
 */
function asError(err) {
  const body = err?.body || {};
  const topError = body?.error || {};
  const failureDetail = (topError.details || []).find(d => (d?.['@type'] || '').includes('GoogleAdsFailure')) || {};
  const rawErrors = failureDetail?.errors || [];
  const errors = (Array.isArray(rawErrors) ? rawErrors : []).map(e => {
    // e.errorCode is like { authorizationError: "USER_PERMISSION_DENIED" }
    let errorClass = null, errorCode = null;
    if (e?.errorCode && typeof e.errorCode === 'object') {
      const entries = Object.entries(e.errorCode);
      if (entries.length) { errorClass = entries[0][0]; errorCode = entries[0][1]; }
    }
    return {
      error_class: errorClass,
      error_code: errorCode,
      message: typeof e?.message === 'string' ? e.message : null,
      trigger: e?.trigger ?? null,
      location: e?.location ?? null,
    };
  });
  const primary = errors[0] || {};

  return {
    isError: true,
    content: [{
      type: 'text',
      text: 'Google Ads API error (via Maton):\n' + JSON.stringify({
        message: primary.message || topError.message || err?.message || 'Unknown error',
        error_class: primary.error_class || null,
        error_code: primary.error_code ?? null,
        http_status: err?.status ?? topError.code ?? null,
        google_status: topError.status ?? null,
        errors_count: errors.length,
        errors,
        request_id: failureDetail?.requestId || null,
      }, null, 2),
    }],
  };
}

// ─── field-name helper — Google REST uses camelCase, gRPC used snake_case ─────

function snakeToCamel(s) { return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

/**
 * Deeply convert an object's keys from snake_case → camelCase so our tool
 * handlers can keep using proto-style names in payload construction (matches
 * the parent MCP's coding style) but send Google's REST-friendly format.
 */
function toCamelDeep(v) {
  if (Array.isArray(v)) return v.map(toCamelDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[snakeToCamel(k)] = toCamelDeep(val);
    return out;
  }
  return v;
}

// ─── tool definitions (19 — schemas match parent was-google-ads-mcp exactly) ──

const LCID_PROP = {
  type: 'string',
  description: 'Override MCC login-customer-id header for this call. Digits only, no dashes. Defaults to the client-level login_customer_id from config.',
};

const tools = [
  { name: 'ads_list_accessible_customers', description: 'List all customer accounts the authorized Google user can manage (under the Maton-connected Google Ads account). Returns resource names. Always start here to discover IDs.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'ads_get_account_summary', description: 'Quick account profile: name, currency, timezone, status, manager flag, test flag, auto-tagging.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, loginCustomerId: LCID_PROP }, required: ['customerId'] } },
  { name: 'ads_query', description: `Run any GAQL query and return rows. UNIVERSAL READ — covers 100% of reporting, inspection, and discovery.

Examples:
- Campaigns: SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS
- Keywords: SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.cost_micros FROM keyword_view WHERE segments.date DURING LAST_7_DAYS
- Search terms: SELECT search_term_view.search_term, metrics.clicks, metrics.cost_micros FROM search_term_view WHERE segments.date DURING LAST_30_DAYS
- Conversions: SELECT conversion_action.id, conversion_action.name, conversion_action.status FROM conversion_action

Reference: https://developers.google.com/google-ads/api/fields/${DEFAULT_API_VERSION}/overview`, inputSchema: { type: 'object', properties: { customerId: { type: 'string', description: '10-digit customer ID' }, gaql: { type: 'string', description: 'Full GAQL query' }, loginCustomerId: LCID_PROP }, required: ['customerId', 'gaql'] } },

  { name: 'ads_mutate', description: `UNIVERSAL WRITE — perform any create/update/remove on any Google Ads resource in one batch. Uses Google's googleAds:mutate endpoint.

Each mutateOperation must specify exactly ONE of:
  - {"campaignOperation": {"create"|"update"|"remove": ...}}
  - {"campaignBudgetOperation": {...}}
  - {"adGroupOperation": {...}}
  - {"adGroupCriterionOperation": {...}}
  - {"conversionActionOperation": {...}}
  - (see full list at https://developers.google.com/google-ads/api/reference/rpc/${DEFAULT_API_VERSION}/MutateGoogleAdsRequest)

Field names in payloads are camelCase (REST), not snake_case (gRPC).
amount_micros → amountMicros. cpc_bid_micros → cpcBidMicros. $50 = 50000000.

For batched cross-references (budget→campaign), use temporary resourceNames with negative IDs.`, inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, mutateOperations: { type: 'array', items: { type: 'object' }, minItems: 1, description: 'Array of Google Ads MutateOperation objects (camelCase REST format)' }, loginCustomerId: LCID_PROP, partialFailure: { type: 'boolean', default: false }, validateOnly: { type: 'boolean', default: false } }, required: ['customerId', 'mutateOperations'] } },

  { name: 'ads_list_campaigns', description: 'List campaigns with 30-day perf (impressions, clicks, cost, conversions, CTR, CPC).', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, loginCustomerId: LCID_PROP }, required: ['customerId'] } },
  { name: 'ads_set_campaign_status', description: 'Pause, enable, or remove a campaign by ID.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, campaignId: { type: 'string' }, status: { type: 'string', enum: ['ENABLED', 'PAUSED', 'REMOVED'] }, loginCustomerId: LCID_PROP }, required: ['customerId', 'campaignId', 'status'] } },
  { name: 'ads_set_campaign_bidding', description: 'Set a campaign bidding strategy. biddingType=MANUAL_CPC | TARGET_CPA | TARGET_ROAS | MAXIMIZE_CONVERSIONS | MAXIMIZE_CONVERSION_VALUE. For TARGET_CPA pass targetCpaMicros. For TARGET_ROAS pass targetRoas (decimal, e.g. 4.0 = 400%).', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, campaignId: { type: 'string' }, biddingType: { type: 'string', enum: ['MANUAL_CPC', 'TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE'] }, targetCpaMicros: { type: 'integer' }, targetRoas: { type: 'number' }, loginCustomerId: LCID_PROP }, required: ['customerId', 'campaignId', 'biddingType'] } },
  { name: 'ads_add_keywords', description: 'Bulk-add positive keywords to an ad group. Match types: EXACT, PHRASE, BROAD.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, adGroupId: { type: 'string' }, keywords: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, matchType: { type: 'string', enum: ['EXACT', 'PHRASE', 'BROAD'], default: 'PHRASE' }, cpcBidMicros: { type: 'integer' } }, required: ['text'] }, minItems: 1 }, loginCustomerId: LCID_PROP }, required: ['customerId', 'adGroupId', 'keywords'] } },
  { name: 'ads_add_negative_keywords', description: 'Bulk-add negative keywords at campaign or adgroup level.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, scope: { type: 'string', enum: ['campaign', 'adgroup'] }, scopeId: { type: 'string' }, keywords: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, matchType: { type: 'string', enum: ['EXACT', 'PHRASE', 'BROAD'], default: 'PHRASE' } }, required: ['text'] }, minItems: 1 }, loginCustomerId: LCID_PROP }, required: ['customerId', 'scope', 'scopeId', 'keywords'] } },

  { name: 'ads_list_conversion_actions', description: 'List all conversion actions: id, name, type, status, category, counting type, default value, lookback windows.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, loginCustomerId: LCID_PROP }, required: ['customerId'] } },
  { name: 'ads_create_conversion_action', description: 'Create a conversion action. type: WEBPAGE | UPLOAD_CLICKS (offline) | UPLOAD_CALLS | WEBSITE_CALL | CLICK_TO_CALL | GA4_CUSTOM | GA4_PURCHASE. category: LEAD | PURCHASE | SIGNUP | PAGE_VIEW | DOWNLOAD | ADD_TO_CART | BEGIN_CHECKOUT | etc.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, name: { type: 'string' }, type: { type: 'string', default: 'WEBPAGE' }, category: { type: 'string' }, countingType: { type: 'string', enum: ['ONE_PER_CLICK', 'MANY_PER_CLICK'], default: 'ONE_PER_CLICK' }, defaultValue: { type: 'number' }, defaultCurrencyCode: { type: 'string', default: 'USD' }, alwaysUseDefaultValue: { type: 'boolean', default: false }, clickThroughLookbackWindowDays: { type: 'integer', default: 30 }, viewThroughLookbackWindowDays: { type: 'integer', default: 1 }, loginCustomerId: LCID_PROP }, required: ['customerId', 'name', 'category'] } },
  { name: 'ads_update_conversion_action', description: 'Update fields on an existing conversion action.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, conversionActionId: { type: 'string' }, name: { type: 'string' }, status: { type: 'string', enum: ['ENABLED', 'REMOVED', 'HIDDEN'] }, category: { type: 'string' }, countingType: { type: 'string', enum: ['ONE_PER_CLICK', 'MANY_PER_CLICK'] }, defaultValue: { type: 'number' }, defaultCurrencyCode: { type: 'string' }, alwaysUseDefaultValue: { type: 'boolean' }, loginCustomerId: LCID_PROP }, required: ['customerId', 'conversionActionId'] } },

  { name: 'ads_upload_click_conversions', description: 'Upload offline click conversions. Each needs gclid OR gbraid/wbraid, plus conversion_action resource_name, conversion_date_time, conversion_value.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, conversions: { type: 'array', items: { type: 'object', properties: { gclid: { type: 'string' }, gbraid: { type: 'string' }, wbraid: { type: 'string' }, conversionAction: { type: 'string' }, conversionDateTime: { type: 'string' }, conversionValue: { type: 'number' }, currencyCode: { type: 'string' }, orderId: { type: 'string' } }, required: ['conversionAction', 'conversionDateTime', 'conversionValue'] }, minItems: 1 }, loginCustomerId: LCID_PROP }, required: ['customerId', 'conversions'] } },
  { name: 'ads_upload_call_conversions', description: 'Upload phone call conversions. Needs caller_id (E.164), call_start_date_time, conversion_action.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, conversions: { type: 'array', items: { type: 'object', properties: { callerId: { type: 'string' }, callStartDateTime: { type: 'string' }, conversionAction: { type: 'string' }, conversionDateTime: { type: 'string' }, conversionValue: { type: 'number' }, currencyCode: { type: 'string' } }, required: ['callerId', 'callStartDateTime', 'conversionAction', 'conversionDateTime', 'conversionValue'] }, minItems: 1 } }, required: ['customerId', 'conversions'] } },

  { name: 'ads_upload_user_data', description: 'Add users to a Customer Match list via SHA-256 hashed PII. userListResourceName is required. Values must be pre-hashed hex strings (lowercase). If you provide raw email, it will be SHA-256 hashed for you.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, userListResourceName: { type: 'string' }, users: { type: 'array', items: { type: 'object', properties: { email: { type: 'string' }, phoneNumber: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' }, countryCode: { type: 'string' }, postalCode: { type: 'string' } } }, minItems: 1 }, consentAdUserData: { type: 'string', enum: ['GRANTED', 'DENIED', 'UNSPECIFIED'], default: 'GRANTED' }, consentAdPersonalization: { type: 'string', enum: ['GRANTED', 'DENIED', 'UNSPECIFIED'], default: 'GRANTED' }, loginCustomerId: LCID_PROP }, required: ['customerId', 'userListResourceName', 'users'] } },

  { name: 'ads_generate_keyword_ideas', description: 'Generate keyword ideas from seed keywords or a URL. Returns ideas with avg monthly searches, competition, CPC range.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } }, url: { type: 'string' }, languageCode: { type: 'string', default: 'en' }, geoTargetIds: { type: 'array', items: { type: 'string' } }, includeAdultKeywords: { type: 'boolean', default: false }, loginCustomerId: LCID_PROP }, required: ['customerId'] } },

  { name: 'ads_list_recommendations', description: 'List active recommendations Google suggests for the account.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, loginCustomerId: LCID_PROP }, required: ['customerId'] } },
  { name: 'ads_apply_recommendation', description: 'Apply a Google recommendation by resource_name.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, recommendationResourceName: { type: 'string' }, loginCustomerId: LCID_PROP }, required: ['customerId', 'recommendationResourceName'] } },
  { name: 'ads_dismiss_recommendation', description: 'Dismiss a recommendation without applying it.', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, recommendationResourceName: { type: 'string' }, loginCustomerId: LCID_PROP }, required: ['customerId', 'recommendationResourceName'] } },
];

// ─── SHA-256 helper for Customer Match PII ────────────────────────────────────

import { createHash } from 'node:crypto';
function sha256Hex(s) { return createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex'); }
const isHex64 = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);

// ─── tool handlers ────────────────────────────────────────────────────────────

async function handleCall(name, args) {
  const cid = args.customerId ? cleanCid(args.customerId) : null;
  const lcid = args.loginCustomerId;

  switch (name) {
    case 'ads_list_accessible_customers': {
      const res = await ads('GET', `/customers:listAccessibleCustomers`, null, lcid);
      return asTextResult(res);
    }

    case 'ads_get_account_summary': {
      const res = await ads('POST', `/customers/${cid}/googleAds:search`, {
        query: `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status, customer.manager, customer.test_account, customer.auto_tagging_enabled FROM customer LIMIT 1`,
      }, lcid);
      return asTextResult(res?.results?.[0]?.customer || null);
    }

    case 'ads_query': {
      const res = await ads('POST', `/customers/${cid}/googleAds:search`, { query: args.gaql }, lcid);
      return asTextResult({ rowCount: (res?.results || []).length, rows: res?.results || [] });
    }

    case 'ads_mutate': {
      const res = await ads('POST', `/customers/${cid}/googleAds:mutate`, {
        mutateOperations: args.mutateOperations,
        partialFailure: args.partialFailure ?? false,
        validateOnly: args.validateOnly ?? false,
      }, lcid);
      return asTextResult(res);
    }

    case 'ads_list_campaigns': {
      const res = await ads('POST', `/customers/${cid}/googleAds:search`, {
        query: `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign_budget.amount_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.ctr, metrics.average_cpc FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC`,
      }, lcid);
      return asTextResult({ rowCount: (res?.results || []).length, rows: res?.results || [] });
    }

    case 'ads_set_campaign_status': {
      const res = await ads('POST', `/customers/${cid}/campaigns:mutate`, {
        operations: [{
          update: { resourceName: `customers/${cid}/campaigns/${args.campaignId}`, status: args.status },
          updateMask: 'status',
        }],
      }, lcid);
      return asTextResult(res);
    }

    case 'ads_set_campaign_bidding': {
      const update = { resourceName: `customers/${cid}/campaigns/${args.campaignId}` };
      const mask = [];
      const t = args.biddingType;
      if (t === 'MANUAL_CPC') { update.manualCpc = {}; mask.push('manualCpc'); }
      else if (t === 'TARGET_CPA') { update.targetCpa = { targetCpaMicros: args.targetCpaMicros }; mask.push('targetCpa.targetCpaMicros'); }
      else if (t === 'TARGET_ROAS') { update.targetRoas = { targetRoas: args.targetRoas }; mask.push('targetRoas.targetRoas'); }
      else if (t === 'MAXIMIZE_CONVERSIONS') { update.maximizeConversions = {}; mask.push('maximizeConversions'); }
      else if (t === 'MAXIMIZE_CONVERSION_VALUE') { update.maximizeConversionValue = {}; mask.push('maximizeConversionValue'); }
      const res = await ads('POST', `/customers/${cid}/campaigns:mutate`, {
        operations: [{ update, updateMask: mask.join(',') }],
      }, lcid);
      return asTextResult(res);
    }

    case 'ads_add_keywords': {
      const adGroupRn = `customers/${cid}/adGroups/${args.adGroupId}`;
      const operations = args.keywords.map(kw => ({
        create: {
          adGroup: adGroupRn,
          status: 'ENABLED',
          keyword: { text: kw.text, matchType: kw.matchType || 'PHRASE' },
          ...(kw.cpcBidMicros ? { cpcBidMicros: kw.cpcBidMicros } : {}),
        },
      }));
      const res = await ads('POST', `/customers/${cid}/adGroupCriteria:mutate`, { operations }, lcid);
      return asTextResult(res);
    }

    case 'ads_add_negative_keywords': {
      if (args.scope === 'campaign') {
        const operations = args.keywords.map(kw => ({
          create: {
            campaign: `customers/${cid}/campaigns/${args.scopeId}`,
            negative: true,
            keyword: { text: kw.text, matchType: kw.matchType || 'PHRASE' },
          },
        }));
        const res = await ads('POST', `/customers/${cid}/campaignCriteria:mutate`, { operations }, lcid);
        return asTextResult(res);
      } else {
        const operations = args.keywords.map(kw => ({
          create: {
            adGroup: `customers/${cid}/adGroups/${args.scopeId}`,
            negative: true,
            keyword: { text: kw.text, matchType: kw.matchType || 'PHRASE' },
          },
        }));
        const res = await ads('POST', `/customers/${cid}/adGroupCriteria:mutate`, { operations }, lcid);
        return asTextResult(res);
      }
    }

    case 'ads_list_conversion_actions': {
      const res = await ads('POST', `/customers/${cid}/googleAds:search`, {
        query: `SELECT conversion_action.id, conversion_action.resource_name, conversion_action.name, conversion_action.type, conversion_action.status, conversion_action.category, conversion_action.counting_type, conversion_action.value_settings.default_value, conversion_action.value_settings.default_currency_code, conversion_action.value_settings.always_use_default_value, conversion_action.click_through_lookback_window_days, conversion_action.view_through_lookback_window_days, conversion_action.primary_for_goal FROM conversion_action ORDER BY conversion_action.id DESC`,
      }, lcid);
      return asTextResult({ rowCount: (res?.results || []).length, rows: res?.results || [] });
    }

    case 'ads_create_conversion_action': {
      const valueSettings = {
        defaultCurrencyCode: args.defaultCurrencyCode || 'USD',
        alwaysUseDefaultValue: args.alwaysUseDefaultValue ?? false,
      };
      if (args.defaultValue !== undefined) valueSettings.defaultValue = args.defaultValue;
      const create = {
        name: args.name,
        type: args.type || 'WEBPAGE',
        category: args.category,
        status: 'ENABLED',
        countingType: args.countingType || 'ONE_PER_CLICK',
        clickThroughLookbackWindowDays: args.clickThroughLookbackWindowDays ?? 30,
        viewThroughLookbackWindowDays: args.viewThroughLookbackWindowDays ?? 1,
        valueSettings,
      };
      const res = await ads('POST', `/customers/${cid}/conversionActions:mutate`, {
        operations: [{ create }],
      }, lcid);
      return asTextResult(res);
    }

    case 'ads_update_conversion_action': {
      const update = { resourceName: `customers/${cid}/conversionActions/${args.conversionActionId}` };
      const mask = [];
      if (args.name !== undefined) { update.name = args.name; mask.push('name'); }
      if (args.status !== undefined) { update.status = args.status; mask.push('status'); }
      if (args.category !== undefined) { update.category = args.category; mask.push('category'); }
      if (args.countingType !== undefined) { update.countingType = args.countingType; mask.push('countingType'); }
      if (args.defaultValue !== undefined || args.alwaysUseDefaultValue !== undefined || args.defaultCurrencyCode !== undefined) {
        update.valueSettings = {};
        if (args.defaultValue !== undefined) { update.valueSettings.defaultValue = args.defaultValue; mask.push('valueSettings.defaultValue'); }
        if (args.defaultCurrencyCode !== undefined) { update.valueSettings.defaultCurrencyCode = args.defaultCurrencyCode; mask.push('valueSettings.defaultCurrencyCode'); }
        if (args.alwaysUseDefaultValue !== undefined) { update.valueSettings.alwaysUseDefaultValue = args.alwaysUseDefaultValue; mask.push('valueSettings.alwaysUseDefaultValue'); }
      }
      const res = await ads('POST', `/customers/${cid}/conversionActions:mutate`, {
        operations: [{ update, updateMask: mask.join(',') }],
      }, lcid);
      return asTextResult(res);
    }

    case 'ads_upload_click_conversions': {
      const conversions = args.conversions.map(c => ({
        gclid: c.gclid,
        gbraid: c.gbraid,
        wbraid: c.wbraid,
        conversionAction: c.conversionAction,
        conversionDateTime: c.conversionDateTime,
        conversionValue: c.conversionValue,
        currencyCode: c.currencyCode,
        orderId: c.orderId,
      }));
      const res = await ads('POST', `/customers/${cid}:uploadClickConversions`, {
        conversions,
        partialFailure: true,
        validateOnly: false,
      }, lcid);
      return asTextResult(res);
    }

    case 'ads_upload_call_conversions': {
      const conversions = args.conversions.map(c => ({
        callerId: c.callerId,
        callStartDateTime: c.callStartDateTime,
        conversionAction: c.conversionAction,
        conversionDateTime: c.conversionDateTime,
        conversionValue: c.conversionValue,
        currencyCode: c.currencyCode,
      }));
      const res = await ads('POST', `/customers/${cid}:uploadCallConversions`, {
        conversions,
        partialFailure: true,
        validateOnly: false,
      }, lcid);
      return asTextResult(res);
    }

    case 'ads_upload_user_data': {
      const operations = args.users.map(u => {
        const identifiers = [];
        if (u.email) {
          const val = isHex64(u.email) ? u.email : sha256Hex(u.email);
          identifiers.push({ hashedEmail: val });
        }
        if (u.phoneNumber) {
          const val = isHex64(u.phoneNumber) ? u.phoneNumber : sha256Hex(u.phoneNumber);
          identifiers.push({ hashedPhoneNumber: val });
        }
        if (u.firstName || u.lastName || u.countryCode || u.postalCode) {
          identifiers.push({
            addressInfo: {
              hashedFirstName: u.firstName ? (isHex64(u.firstName) ? u.firstName : sha256Hex(u.firstName)) : undefined,
              hashedLastName: u.lastName ? (isHex64(u.lastName) ? u.lastName : sha256Hex(u.lastName)) : undefined,
              countryCode: u.countryCode,
              postalCode: u.postalCode,
            },
          });
        }
        return { create: { userIdentifiers: identifiers } };
      });
      const res = await ads('POST', `/customers/${cid}:uploadUserData`, {
        operations,
        customerMatchUserListMetadata: {
          userList: args.userListResourceName,
          consent: {
            adUserData: args.consentAdUserData || 'GRANTED',
            adPersonalization: args.consentAdPersonalization || 'GRANTED',
          },
        },
      }, lcid);
      return asTextResult(res);
    }

    case 'ads_generate_keyword_ideas': {
      const req = {
        language: args.languageCode ? `languageConstants/${args.languageCode}` : 'languageConstants/1000',
        geoTargetConstants: (args.geoTargetIds || []).map(g => `geoTargetConstants/${g}`),
        includeAdultKeywords: args.includeAdultKeywords || false,
      };
      if (args.url && args.keywords?.length) req.keywordAndUrlSeed = { keywords: args.keywords, url: args.url };
      else if (args.keywords?.length) req.keywordSeed = { keywords: args.keywords };
      else if (args.url) req.urlSeed = { url: args.url };
      else throw new Error('Provide at least one of: keywords[], url');
      const res = await ads('POST', `/customers/${cid}:generateKeywordIdeas`, req, lcid);
      const results = res?.results || [];
      return asTextResult({ count: results.length, ideas: results.slice(0, 100) });
    }

    case 'ads_list_recommendations': {
      const res = await ads('POST', `/customers/${cid}/googleAds:search`, {
        query: `SELECT recommendation.resource_name, recommendation.type, recommendation.dismissed, recommendation.impact.base_metrics.impressions, recommendation.impact.base_metrics.clicks, recommendation.impact.base_metrics.cost_micros, recommendation.impact.potential_metrics.impressions, recommendation.impact.potential_metrics.clicks, recommendation.impact.potential_metrics.cost_micros FROM recommendation WHERE recommendation.dismissed = FALSE`,
      }, lcid);
      return asTextResult({ rowCount: (res?.results || []).length, rows: res?.results || [] });
    }

    case 'ads_apply_recommendation': {
      const res = await ads('POST', `/customers/${cid}/recommendations:apply`, {
        operations: [{ resourceName: args.recommendationResourceName }],
      }, lcid);
      return asTextResult(res);
    }

    case 'ads_dismiss_recommendation': {
      const res = await ads('POST', `/customers/${cid}/recommendations:dismiss`, {
        operations: [{ resourceName: args.recommendationResourceName }],
      }, lcid);
      return asTextResult(res);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP server wiring ────────────────────────────────────────────────────────

const server = new Server(
  { name: 'was-google-ads-mcp-maton', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await handleCall(request.params.name, request.params.arguments || {});
  } catch (err) {
    return asError(err);
  }
});

await server.connect(new StdioServerTransport());
console.error(`was-google-ads-mcp-maton v0.1.0 ready — ${tools.length} tools loaded (Google Ads API ${API_VERSION} via Maton at ${MATON_BASE_URL})`);
