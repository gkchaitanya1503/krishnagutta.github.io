# Workday MCP Server

A generic [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects Claude Desktop to Workday's REST and SOAP APIs using OAuth 2.0 with PKCE authentication.

Any Workday customer can deploy this — no code changes needed. Just configure your tenant details and go.

## Architecture

```
┌──────────────────┐     stdio      ┌──────────────────┐
│  Claude Desktop  │◄──────────────►│  mcp-server.mjs  │
│                  │                │  (local machine)  │
└──────────────────┘                └────────┬─────────┘
                                             │ polls /session/:key
                                             ▼
                                    ┌──────────────────┐
                                    │   server.mjs     │
                                    │  (Codespace)     │
                                    │  HTTPS relay     │
                                    └────────┬─────────┘
                                             │ OAuth PKCE
                                             ▼
                                    ┌──────────────────┐
                                    │    Workday API   │
                                    │  REST + SOAP     │
                                    └──────────────────┘
```

**Why a Codespace?** Workday's OAuth requires an HTTPS redirect URI — `localhost` is not allowed. A GitHub Codespace provides a stable public HTTPS URL automatically.

## Auth Flow

1. User calls `authenticate_workday` tool in Claude Desktop
2. Browser opens → user signs into Workday
3. Workday redirects to Codespace with auth code
4. Codespace exchanges code for token (PKCE)
5. Local MCP server polls Codespace → gets token
6. All future tool calls use the token automatically

**Zero config editing.** No token copying. The user just signs in once.

---

## Admin Deployment Guide

### Prerequisites

- A GitHub account (for Codespaces)
- Workday admin access to register an API Client
- Node.js 20+ (Codespace includes this)

### Step 1 — Configure Workday API Client

In your Workday tenant, go to **Register API Client for Integrations** and configure:

| Setting | Value |
|---------|-------|
| **Client Name** | `Claude MCP Server` (or any name) |
| **Grant Type** | Authorization Code Grant |
| **PKCE** | **Enabled** (Required) |
| **Access Token Type** | Bearer |
| **Redirect URI** | `https://<CODESPACE>-4000.<DOMAIN>/callback` (get this from Step 2) |
| **Scopes (Functional Areas)** | See table below |

#### Recommended Scopes

Add these functional area scopes based on the tools you want to enable:

| Scope | Enables Tools |
|-------|--------------|
| **Staffing** | `get_my_profile`, `get_my_job_profile`, `get_my_manager`, `get_my_direct_reports`, `search_workers`, `lookup_worker`, `get_org_chart`, `get_org_members`, `get_open_positions`, `get_my_worker_history` |
| **Human Resources** | `get_my_compensation`, `get_my_benefit_enrollments` (SOAP) |
| **Absence Management** | `get_my_time_off`, `get_my_time_off_balance`, `get_eligible_absence_types`, `request_time_off` |
| **Compensation** | `get_my_compensation` (REST) |
| **Benefits** | `get_my_benefits` |
| **Business Process** | `get_my_inbox`, `approve_inbox_item`, `deny_inbox_item`, `get_event_status` |
| **Payroll** | `request_one_time_payment` |

> **Important:** Note the **Client ID** and **Authorization Endpoint URL** shown on the API client page. The Authorization Endpoint hostname is often **different** from the REST API hostname.

### Step 2 — Create a GitHub Codespace

1. Fork or clone this repository
2. Click **Code → Codespaces → Create codespace on main**
3. Wait for the Codespace to start (dependencies install automatically)
4. In the **Ports** tab, find port `4000` and set visibility to **Public**
5. Copy the forwarded URL — it looks like: `https://name-4000.app.github.dev`

### Step 3 — Configure Environment

In the Codespace terminal:

```bash
cp .env.example .env
```

Edit `.env` with your tenant details:

```env
WORKDAY_TENANT_ID=your_tenant_id
WORKDAY_BASE_URL=https://wd5-impl-services1.workday.com
WORKDAY_CLIENT_ID=your_client_id_from_step_1
WORKDAY_AUTH_URL=https://your-auth-host.workday.com/your_tenant/authorize
PORT=4000
ADMIN_KEY=pick-a-secret-key
```

> **Critical:** Set `WORKDAY_AUTH_URL` to the exact **Authorization Endpoint** URL shown on your Workday API client page. Do NOT assume it matches `WORKDAY_BASE_URL`.

### Step 4 — Start the Server

```bash
npm run dev      # Direct (for testing)
# or
npm start        # Via PM2 (for production — auto-restarts)
```

Verify at: `https://<CODESPACE>-4000.<DOMAIN>/health`

### Step 5 — Update the Redirect URI

Now that you have the Codespace URL, go back to Workday and update the API Client's Redirect URI:

```
https://<CODESPACE-NAME>-4000.<DOMAIN>/callback
```

### Step 6 — Distribute to Users

Share the **setup link** with your team:

```
https://<CODESPACE-NAME>-4000.<DOMAIN>/setup
```

Or have them run the CLI setup script (see [SETUP_GUIDE.md](SETUP_GUIDE.md)).

---

## Keeping the Codespace Alive

Codespaces auto-sleep after inactivity. To prevent this during demos:

1. **GitHub Actions:** Enable the included `keep-alive.yml` workflow
   - Go to **Settings → Variables → Actions → New variable**
   - Name: `CODESPACE_URL`, Value: your Codespace URL
   - Enable the workflow in the **Actions** tab

2. **Codespace timeout:** Go to https://github.com/settings/codespaces and set **Default idle timeout** to 240 minutes

---

## Admin Dashboard

View active sessions, auth events, and relay status:

```
https://<CODESPACE>-4000.<DOMAIN>/admin?key=YOUR_ADMIN_KEY
```

---

## Environment Variable Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `WORKDAY_TENANT_ID` | Yes | Your Workday tenant ID |
| `WORKDAY_BASE_URL` | Yes | Workday API hostname (e.g. `https://wd5-impl-services1.workday.com`) |
| `WORKDAY_CLIENT_ID` | Yes | OAuth client ID from API Client registration |
| `WORKDAY_AUTH_URL` | Recommended | Authorization endpoint URL (may differ from BASE_URL) |
| `WORKDAY_TOKEN_URL` | No | Token endpoint (auto-derived: `{BASE_URL}/ccx/oauth2/{TENANT}/token`) |
| `WORKDAY_REDIRECT_URI` | No | Override redirect URI (auto-detected in Codespaces) |
| `PORT` | No | Server port (default: 4000) |
| `ADMIN_KEY` | No | Admin dashboard password (default: `change-this-to-a-secret`) |
| `WORKDAY_ACCESS_TOKEN` | No | Pre-seeded token to skip OAuth flow |

---

## API Endpoints (server.mjs)

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Health check with uptime and session count |
| `GET /setup` | Browser setup page with "Connect Workday" button |
| `GET /oauth/login?relay=KEY` | Starts PKCE OAuth flow, redirects to Workday |
| `GET /callback` | OAuth callback — exchanges code for token |
| `GET /session/:key` | Token polling endpoint for mcp-server.mjs |
| `GET /admin?key=SECRET` | Admin dashboard with sessions and event log |

---

## Available MCP Tools (25)

| Category | Tool | Description |
|----------|------|-------------|
| **Auth** | `authenticate_workday` | Open browser to sign into Workday |
| **Profile** | `get_my_profile` | Your name, title, department, location |
| | `get_my_job_profile` | Job family, management level |
| | `get_my_manager` | Your manager's details |
| | `get_my_full_summary` | All-in-one snapshot |
| **Organization** | `get_org_chart` | Supervisory org hierarchy |
| | `get_org_members` | Members of an org |
| | `get_my_direct_reports` | Your direct reports |
| | `get_orgs_i_manage` | Orgs you manage |
| | `get_worker_organizations` | All orgs for a worker |
| **Search** | `search_workers` | Find colleagues by name |
| | `lookup_worker` | Look up worker by ID |
| **Time Off** | `get_my_time_off` | Your time-off requests |
| | `get_my_time_off_balance` | Current PTO balances |
| | `get_eligible_absence_types` | Available time-off types |
| | `request_time_off` | Submit a time-off request |
| **Compensation** | `get_my_compensation` | Your compensation details |
| **Benefits** | `get_my_benefits` | Benefit elections |
| | `get_my_benefit_enrollments` | Detailed benefit breakdown (SOAP) |
| **Inbox** | `get_my_inbox` | Pending approvals and tasks |
| | `approve_inbox_item` | Approve an inbox item |
| | `deny_inbox_item` | Deny an inbox item |
| **History** | `get_my_worker_history` | Employment history |
| | `get_open_positions` | Open positions in your org |
| **Manager** | `request_one_time_payment` | Submit a spot bonus (SOAP) |
| **Status** | `get_event_status` | Check business process status |

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| "The requested resource is not available" on auth | Wrong authorize URL | Copy the exact **Authorization Endpoint** URL from Workday's API client page. Set as `WORKDAY_AUTH_URL`. |
| Claude shows "tool not found" | Config not loaded | Restart Claude Desktop fully (quit + reopen) |
| 401 Unauthorized on tool calls | Token expired (~1 hour) | Call `authenticate_workday` again |
| Codespace URL returns 404 | Port not public | Ports tab → right-click port → Port Visibility → Public |
| PM2 crash on startup | Missing env vars | Run `pm2 logs workday-mcp` to see which var is missing |
| "Auth timeout" after signing in | Relay session expired | Try `authenticate_workday` again |
| 403 on a specific tool | Workday security role | Your role doesn't permit that action — contact your Workday admin |

---

## PM2 Commands

```bash
npm start          # Start via PM2
npm stop           # Stop
npm run restart    # Restart
npm run reload     # Git pull + npm install + restart
npm run logs       # View last 50 log lines
npm run status     # PM2 process status
```

---

## License

MIT
