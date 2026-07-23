# Changelog

## 0.1.0 — 2026-07-23

Initial release.

- Full Google Ads MCP surface via Maton API gateway — 19 tools, no Google developer token / OAuth flow required
- Setup: one Maton API key, verified in `auth` CLI
- Endpoints proxied through Maton to Google Ads REST API `v23`:
  - Discovery: `list_accessible_customers`, `get_account_summary`
  - Universal read: `query` (GAQL via `googleAds:search`)
  - Universal write: `mutate` (`googleAds:mutate` with `mutateOperations`)
  - Campaigns: `list_campaigns`, `set_campaign_status`, `set_campaign_bidding`
  - Keywords: `add_keywords`, `add_negative_keywords`
  - Conversion tracking (full parity with direct variant): `list_conversion_actions`, `create_conversion_action`, `update_conversion_action`, `upload_click_conversions`, `upload_call_conversions`
  - Customer Match: `upload_user_data` (SHA-256 done client-side, raw PII never sent)
  - Research: `generate_keyword_ideas`
  - Recommendations: `list_recommendations`, `apply_recommendation`, `dismiss_recommendation`
- All 19 tools expose an optional `loginCustomerId` argument for cross-MCC calls
- `login-customer-id` propagates as an HTTP header on every request
- Config file `~/.was-google-ads-mcp-maton/config.json` (mode 0600); env-var overrides supported
- `GoogleAdsFailure` errors decoded into a clean `{error_class, error_code, message}` payload at the top level (no `[object Object]`)
- Version 0.1.0 pins to Google Ads REST `v23` per Maton's current proxy support — bump `GOOGLE_ADS_API_VERSION` env var when Maton advances
