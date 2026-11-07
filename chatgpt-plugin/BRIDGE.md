# FindMyDeal Instant for ChatGPT

The private Sites-hosted MCP server in this directory provides `start_instant_search` and `get_instant_search`. An outbound-only process on the FindMyDeal server polls the relay and calls `/api/instant`; it does not expose the app or require Docker access. Search requests, status and results expire after one hour and are cleaned up during normal relay activity. The bridge needs the Site service-access token and a separate bridge token; keep both in a root-readable-only environment file and out of source control.

The host bridge is `scripts/chatgpt-instant-bridge.js` in the FindMyDeal repository. Run it with Node.js 22 or later and set `FMD_RELAY_URL`, `FMD_SITE_TOKEN`, `FMD_BRIDGE_TOKEN`, and optionally `FMD_LOCAL_URL` (default `http://127.0.0.1:3000`). The relay URL must use HTTPS and the local address must be localhost or a private IPv4 address. Run the process as a dedicated unprivileged service account that can reach the app. The configured Site is private to its owner; do not share it without reviewing the scope of access to search requests and results.

The relay is maintained as a separate Site source repository. Its `.openai/hosting.json` identifies that Site; use the Sites workflow and retain the same identity when publishing edits. The snapshot here documents the deployed relay alongside the host bridge.
