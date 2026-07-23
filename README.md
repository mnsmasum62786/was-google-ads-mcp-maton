# WAS Google Ads MCP — Maton edition

Manage Google Ads from Claude Desktop, Cursor, Codex, Antigravity or any MCP client — **without applying for a Google Ads developer token or minting an OAuth refresh token**. Auth is one Maton API key. 19 tools cover the full Google Ads API surface including conversion tracking, Customer Match, and campaign management.

Built by [Abdullah Al Masum](https://webanalyticssolution.com) — Web Analytics Solution (WAS). MIT licensed. 100 % local — Maton is the only outbound network dependency.

## How this differs from `was-google-ads-mcp`

|  | `was-google-ads-mcp` (direct) | **`was-google-ads-mcp-maton`** (this repo) |
|---|---|---|
| Google Cloud project | Required (student creates one) | Not needed |
| OAuth Client ID + Secret | Required | Not needed |
| Google Ads developer token application | Required (24-72 h approval) | Not needed — Maton provides it |
| Refresh token | Required (auto-minted by CLI) | Not needed |
| Setup time | ~15 min per student | ~2 min per student |
| API version | v24 (current stable) | v23 (whatever Maton proxies) |
| Data path | Direct to Google | Through Maton's gateway |
| Best for | Advanced students, production accounts | Training students, quick prototypes, personal use |

## Prerequisites

| | Required | Notes |
|---|---|---|
| **Node.js 18+** | Yes | `brew install node` on Mac · nodejs.org on Windows |
| **A Maton account** | Yes | Sign up free at https://www.maton.ai/ |
| **A Google Ads account** | Yes | Any active Google Ads account. Manager (MCC) preferred. |

## Quick start — 3 steps

### Step 1 — Get a Maton API key

1. Open https://www.maton.ai/ → sign up (free plan is fine to start)
2. In the dashboard, connect your **Google Ads** integration → one-click OAuth
3. **Settings → API Keys → Create key** → copy it

### Step 2 — Connect this MCP

```bash
npx -y github:mnsmasum62786/was-google-ads-mcp-maton auth
```

You'll be asked to:
1. Paste your **Maton API key**
2. Optionally paste a default **MCC login_customer_id** (10 digits, no dashes) — can be overridden per call

The CLI verifies the key against Maton and saves it to `~/.was-google-ads-mcp-maton/config.json` (mode 0600).

### Step 3 — Add 4 lines to Claude Desktop config

Open the config file:

- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Paste (merge with any existing `mcpServers`):

```json
{
  "mcpServers": {
    "WAS Google Ads MCP (Maton)": {
      "command": "npx",
      "args": ["-y", "github:mnsmasum62786/was-google-ads-mcp-maton"]
    }
  }
}
```

Fully quit Claude (Cmd + Q on Mac) and reopen. In a new chat:

> "Run ads_list_accessible_customers."

Returns a list of Google Ads customer resource names accessible via your Maton-connected account.

## CLI commands

```bash
npx -y github:mnsmasum62786/was-google-ads-mcp-maton           # Start MCP server (Claude uses this)
npx -y github:mnsmasum62786/was-google-ads-mcp-maton auth      # Connect / re-connect with a new key
npx -y github:mnsmasum62786/was-google-ads-mcp-maton status    # Show config summary (redacted)
npx -y github:mnsmasum62786/was-google-ads-mcp-maton logout    # Delete saved credentials
npx -y github:mnsmasum62786/was-google-ads-mcp-maton help      # Usage
```

## What you can ask Claude

**Discovery**
- "List my Google Ads accounts."
- "Show me the account summary for 5754653194."

**Reporting (GAQL — universal read)**
- "Run this GAQL on 5754653194: SELECT campaign.name, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC"
- "Show me the top 20 search terms by clicks last 7 days on customer X."
- "Which conversion actions are active on customer X?"

**Campaign management**
- "Pause campaign 999 on customer X."
- "List all campaigns on customer X with 30-day performance."
- "Set target CPA to $50 on campaign 999."
- "Add these keywords to ad group Y: [buy shoes, running shoes, ...]"

**Conversion tracking (the WAS specialty)**
- "Create a Purchase conversion action on customer X with default value $100."
- "List all conversion actions."
- "Upload these offline click conversions: [{gclid: ..., conversionAction: customers/X/conversionActions/N, conversionDateTime: ..., conversionValue: 50}, ...]"
- "Upload phone call conversions from this CSV."

**Customer Match (audience upload)**
- "Upload these emails to Customer Match list customers/X/userLists/Y: [alice@example.com, bob@example.com] — hash them for me."

**Recommendations**
- "List active recommendations on customer X."
- "Apply recommendation customers/X/recommendations/N."

## All 19 tools

| Category | Tools |
|---|---|
| **Discovery** (2) | list_accessible_customers, get_account_summary |
| **Universal READ** (1) | query (GAQL) |
| **Universal WRITE** (1) | mutate (any resource) |
| **Campaigns** (3) | list_campaigns, set_campaign_status, set_campaign_bidding |
| **Keywords** (2) | add_keywords, add_negative_keywords |
| **Conversions** (5) | list_conversion_actions, create_conversion_action, update_conversion_action, upload_click_conversions, upload_call_conversions |
| **Customer Match** (1) | upload_user_data (SHA-256 done client-side) |
| **Research** (1) | generate_keyword_ideas |
| **Recommendations** (3) | list_recommendations, apply_recommendation, dismiss_recommendation |

All tools accept an optional `loginCustomerId` argument for cross-MCC calls.

## Advanced: multi-account setup

If you manage Google Ads for multiple Maton accounts (e.g. separate agency + personal):

```json
{
  "mcpServers": {
    "Google Ads — Agency (Maton)": {
      "command": "npx",
      "args": ["-y", "github:mnsmasum62786/was-google-ads-mcp-maton"],
      "env": {
        "MATON_API_KEY": "matn_...agency-key",
        "GOOGLE_ADS_LOGIN_CUSTOMER_ID": "1234567890"
      }
    },
    "Google Ads — Personal (Maton)": {
      "command": "npx",
      "args": ["-y", "github:mnsmasum62786/was-google-ads-mcp-maton"],
      "env": {
        "MATON_API_KEY": "matn_...personal-key"
      }
    }
  }
}
```

Env vars override the saved config file when set.

## How it works

```
Claude Desktop  →  local Node process (stdio)  →  https://api.maton.ai/google-ads/v23/...
                                                          |
                                                          v
                                                   Maton injects
                                                   OAuth + developer-token
                                                          |
                                                          v
                                                   googleads.googleapis.com
```

- Every tool is a `fetch()` call to Maton's Google Ads passthrough
- Field names in payloads are camelCase (REST format), not snake_case (gRPC)
- `login-customer-id` propagates as an HTTP header
- Customer Match emails/phone/names are SHA-256 hashed client-side before upload
- Errors decode Google's `GoogleAdsFailure` structure into a clean payload with `error_class`, `error_code`, `message` at the top level

## Environment variable reference

| Variable | Purpose | Default |
|---|---|---|
| `MATON_API_KEY` | Your Maton API key | (from config file) |
| `MATON_BASE_URL` | Maton API base | `https://api.maton.ai` |
| `GOOGLE_ADS_API_VERSION` | Google Ads API version Maton proxies | `v23` |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Default MCC ID (digits) | (none) |

## Trade-offs vs. the direct variant

**Pros:**
- No developer token application. Anyone with a Google Ads account can start in 2 minutes.
- No OAuth flow. No refresh token expiry (`invalid_grant`) headaches.
- Same key works for GA4, HubSpot, GHL, and 100+ other tools inside Maton.
- Free tier: unlimited proxy requests + 30 active connections.

**Cons:**
- Data flows through Maton's servers (SOC 2 / GDPR "in progress" as of 2026). Evaluate before moving client PII.
- Maton is currently pinned to Google Ads API **v23**. If Google sunsets v23 before Maton bumps to v24, you'll get `UNIMPLEMENTED` errors — same class of failure the direct variant faced. Check https://github.com/maton-ai/api-gateway-skill for their version status.
- Rate limits: 10 req/s free, 50 req/s Growth ($200/mo). Large offline conversion uploads may need pacing.
- Vendor dependency: if Maton goes down, this MCP goes down.

## Security notes

- API key saved to `~/.was-google-ads-mcp-maton/config.json` with `0600` permissions
- stdio transport — no inbound HTTP port, no local network exposure
- Revoke key any time in your Maton dashboard
- SHA-256 hashing for Customer Match happens client-side; raw PII never leaves your machine

## Troubleshooting

**`Maton probe failed: ...`** during `auth` — key is wrong, expired, or your Google Ads account isn't connected in Maton yet. Fix in Maton dashboard, retry.

**`UNIMPLEMENTED: GRPC target method can't be resolved`** — Maton's API version pin is behind Google's current stable. Report in Maton's Discord and consider using the direct `was-google-ads-mcp` variant temporarily.

**"User doesn't have permission to access customer" (`authorization_error: 2`)** — pass `loginCustomerId` with the correct MCC ID in the tool call. Or configure a default via `auth` / env var.

**Rate limit errors (`429`)** — free plan is 10 req/s. Upgrade Maton plan or add backoff.

## License

MIT. Built by [Abdullah Al Masum](https://webanalyticssolution.com).
