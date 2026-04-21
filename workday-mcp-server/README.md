# Workday MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Status: POC](https://img.shields.io/badge/status-proof%20of%20concept-orange)
![Node: 20+](https://img.shields.io/badge/node-20%2B-green)

A **Model Context Protocol (MCP) server for Workday**, secured with OAuth 2.0 + PKCE. Lets Claude Desktop query and act on Workday HCM data on behalf of the signed-in user.

> **⚠️ Proof of Concept.** This project is a reference implementation — not a production-hardened product. Review the [Security considerations](#security-considerations) before deploying to real users.

---

## Table of Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Quick start for admins](#quick-start-for-admins)
  - [1. Workday API Client setup](#1-workday-api-client-setup)
  - [2. Deploy the server](#2-deploy-the-server)
  - [3. Share the setup URL](#3-share-the-setup-url)
- [End-user setup](#end-user-setup)
- [Environment variables](#environment-variables)
- [Tools exposed](#tools-exposed)
- [Development](#development)
- [Security considerations](#security-considerations)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## What it does

Claude Desktop → MCP → Workday REST APIs. The user signs in once with their Workday credentials; Claude then uses their scoped token to answer questions and take actions:

- **Profile & Org** — "Who is my manager?" · "Show my org chart"
- **Time Off** — "What's my PTO balance?" · "Request 3 days off starting next Monday"
- **Inbox** — "What's in my Workday inbox?" · "Approve the time-off request from Alex"
- **Compensation & Benefits** — "Show my comp" · "What benefits am I enrolled in?"
- **Search** — "Find Jamie in engineering"
- **History** — "Show my employment history"

All actions run under the user's own Workday permissions — no service accounts, no shared credentials.

---

## Architecture

Two components:

- **`server.mjs`** — HTTPS OAuth relay, runs in a GitHub Codespace. Workday requires an HTTPS redirect URI; Codespaces give you a free public one.
- **`mcp-server.mjs`** — Local stdio MCP server, runs on the user's machine via Claude Desktop. Talks to Workday APIs directly using the relayed token.

```
┌─────────────┐   stdio    ┌──────────────┐   fetch     ┌──────────────────┐
│   Claude    │ ◀────────▶ │ mcp-server   │ ──────────▶ │  Workday REST    │
│   Desktop   │            │ .mjs (local) │             │  API             │
└─────────────┘            └──────┬───────┘             └──────────────────┘
                                  │ poll for token
                                  ▼
                           ┌──────────────┐   browser   ┌──────────────────┐
                           │  server.mjs  │ ──OAuth──▶  │ Workday authorize│
                           │  (Codespace) │             │ + token endpoint │
                           └──────────────┘             └──────────────────┘
```

**Why non-blocking auth matters:** the MCP stdio transport times out if a tool handler blocks for > ~30s. `authenticate_workday` opens a browser and returns immediately; a background poll fetches the token from the relay once the user finishes sign-in.

---

## Quick start for admins

### 1. Workday API Client setup

Ask your Workday administrator to register an **API Client** in the tenant:

- **Create Task:** `Register API Client for Integrations` (or `Register API Client` if you want PKCE in a tenant-local client)
- **Fields to set:**

  | Field | Value |
  |---|---|
  | Client Grant Type | **Authorization Code Grant** |
  | PKCE Required | ✅ **Enabled** |
  | Access Token Type | **Bearer** |
  | Redirection URI | `https://<YOUR-CODESPACE>-4000.app.github.dev/callback` |
  | Refresh Token Timeout | 30 days (or whatever your security policy allows) |
  | Scope (Functional Areas) | Staffing, Human Resources, Absence Management, Compensation, Benefits, Payroll — add whichever you want to expose |

- **After saving**, Workday shows:
  - `Client ID` (safe to commit — not secret in PKCE)
  - `Workday REST API Endpoint`      → use as `WORKDAY_BASE_URL`
  - `Token Endpoint`                 → use as `WORKDAY_TOKEN_URL`
  - **`Authorization Endpoint`**     → use as `WORKDAY_AUTH_URL`

> ⚠️ **Important:** the Authorization Endpoint hostname is often **different** from the API/token hostname (e.g. `wd5-impl.workday.com` vs `wd5-impl-services1.workday.com`). Copy it verbatim from the API client page. Don't derive it.

### 2. Deploy the server

**Option A — GitHub Codespace (recommended):**

1. Fork this repo: `github.com/gkchaitanya1503/workday-oauth-poc`
2. Code → Codespaces → **New codespace**
3. Wait for the devcontainer to start. PM2 will auto-start `server.mjs` on port 4000.
4. **Ports tab** → right-click 4000 → Port Visibility → **Public** (already set by postStart, but verify)
5. Copy the forwarded URL (e.g. `https://fuzzy-waffle-123-4000.app.github.dev`)
6. In the Codespace terminal: `cp .env.example .env` and fill in values from Step 1
7. Restart: `npm run reload`
8. Verify: `curl https://<YOUR-URL>/health` should return `{"status":"ok",...}`

**Option B — Any HTTPS host (Fly.io, Render, Cloud Run, etc.):**

Just make sure you can register the public `/callback` URL in Workday's API client settings.

### 3. Share the setup URL

Send your users:

```
https://<YOUR-CODESPACE-URL>/setup
```

That page walks them through the OAuth flow. See [End-user setup](#end-user-setup) below.

---

## End-user setup

See **[SETUP_GUIDE.md](./SETUP_GUIDE.md)** — a standalone doc you can share with end users.

TL;DR:

1. Open `https://<relay>/setup`
2. Click **Connect Workday Account** → sign in
3. Copy the generated `claude_desktop_config.json` snippet
4. Paste into Claude Desktop config, restart, done

Or, for the stdio transport (local MCP server):

```bash
git clone https://github.com/gkchaitanya1503/workday-oauth-poc.git
cd workday-oauth-poc
node setup.js
```

---

## Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `WORKDAY_TENANT_ID` | ✅ | Your Workday tenant ID (e.g. `acme_corp1`) |
| `WORKDAY_BASE_URL` | ✅ | Workday REST API base (no trailing slash) |
| `WORKDAY_CLIENT_ID` | ✅ | From "Register API Client" in Workday |
| `WORKDAY_AUTH_URL` | ✅ | **Authorization Endpoint** from the API client page |
| `WORKDAY_TOKEN_URL` | ✅ | **Token Endpoint** from the API client page |
| `REDIRECT_URI` | — | Auto-detected in Codespaces. Override for other hosts. |
| `PORT` | — | Defaults to `4000` |
| `ADMIN_KEY` | — | Password for `/admin` dashboard. **Change the default.** |
| `WORKDAY_ACCESS_TOKEN` | — | Pre-seed a token to skip OAuth (testing only) |

For the local `mcp-server.mjs`, Claude Desktop injects config via `env`:

```json
{
  "mcpServers": {
    "workday": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server.mjs"],
      "env": {
        "WORKDAY_TENANT_ID": "your_tenant_id",
        "WORKDAY_BASE_URL":  "https://wd5-impl-services1.workday.com",
        "WORKDAY_POC_URL":   "https://<codespace>-4000.app.github.dev"
      }
    }
  }
}
```

---

## Tools exposed

| Tool | What it does |
|---|---|
| `authenticate_workday` | Opens browser for OAuth sign-in (non-blocking) |
| `check_auth_status` | Whether token is ready |
| `get_my_profile` | Name, title, department, location, manager |
| `get_my_job_profile` | Job family, level, management level |
| `get_my_manager` | Manager details |
| `get_my_full_summary` | All-in-one snapshot |
| `get_org_chart` | Supervisory org hierarchy |
| `get_org_members` | Members of a given org |
| `get_my_direct_reports` | Direct reports (managers) |
| `get_orgs_i_manage` | Orgs you manage |
| `search_workers` | Search colleagues by name |
| `lookup_worker` | Public profile of a worker by ID |
| `get_my_time_off` | Upcoming/recent time-off requests |
| `get_my_time_off_balance` | Current balances |
| `get_eligible_absence_types` | Types you can request |
| `request_time_off` | Submit a request |
| `get_my_compensation` | Current compensation |
| `get_my_benefits` | Benefit elections |
| `get_my_inbox` | Pending approval tasks |
| `approve_inbox_item` | Approve by event ID |
| `deny_inbox_item` | Deny by event ID |
| `get_my_worker_history` | Employment history |
| `get_event_status` | Check a business-process event |

Extending with more tools is straightforward — see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Development

```bash
npm install
cp .env.example .env            # fill in values
node server.mjs                 # relay on :4000
node mcp-server.mjs             # local stdio server (needs WORKDAY_POC_URL)
node poc.js                     # standalone PKCE tester
```

Scripts:

- `npm start` — run `server.mjs` under PM2
- `npm run reload` — `git pull` + `npm install` + PM2 restart (Codespace)
- `npm run logs` — tail PM2 logs
- `npm run lint` — Node syntax check on all JS files
- `npm run demo-warmup -- https://my-codespace-4000.app.github.dev` — pre-demo health check

---

## Security considerations

- **PKCE, not client secret.** The server never handles a client secret; tokens are bound to a per-session code verifier.
- **No token persistence on disk by default.** User tokens live in memory + `sessions.json` (for the HTTP transport only). Add `sessions.json` to your `.gitignore` (already done).
- **`ADMIN_KEY`** — change the default. The `/admin` dashboard exposes session metadata.
- **Codespace port visibility.** Port 4000 must be **public** for OAuth redirects to work, but this also makes `/setup` world-readable. Treat the Codespace URL as effectively public.
- **Token scope = user's Workday permissions.** A user can only see / do what they could in Workday itself. There is no elevation.
- **HTTPS only.** Never use `http://` for `WORKDAY_POC_URL` or the redirect URI.
- **Review [SECURITY.md](./SECURITY.md)** for responsible disclosure.

This is a POC — it has not been formally security-reviewed. Don't deploy to production without:
- Running your own security review
- Adding rate limiting and brute-force protection
- Moving session storage to a real database
- Adding audit logging beyond `eventLog`

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `The requested resource is not available` on sign-in | Wrong `WORKDAY_AUTH_URL` | Copy the exact Authorization Endpoint URL from your Workday API client page. Don't derive. |
| Claude Desktop disconnects right after `authenticate_workday` | Blocking stdio transport | Already fixed in this impl — make sure you're running the latest `mcp-server.mjs`. |
| Tools return `401` after auth | Token expired (~60 min) | Call `authenticate_workday` again. |
| Codespace URL returns 404 | Port not public | Ports tab → right-click 4000 → Port Visibility → Public. |
| PM2 crash at startup | Missing env var | `npm run logs` to see which. |
| Tool returns `403` | User lacks Workday permission | Request the relevant functional area access via Workday admin. |

---

## Contributing

See **[CONTRIBUTING.md](./CONTRIBUTING.md)**. PRs welcome — please keep them focused and include a rationale.

## License

[MIT](./LICENSE)
