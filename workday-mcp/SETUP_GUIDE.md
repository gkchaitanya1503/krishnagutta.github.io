# Workday MCP — User Setup Guide

Get Claude Desktop connected to Workday in ~3 minutes. No GitHub account, no code.

---

## Prerequisites

- [Claude Desktop](https://claude.ai/download) installed on your Mac or Windows PC
- Your Workday credentials (SSO or username/password)
- The Codespace URL from your Workday MCP admin

---

## Option A — Automated Setup (Recommended)

If your admin shared the project folder with you:

```bash
cd /path/to/workday-mcp
node setup.js
```

Follow the prompts — it will configure Claude Desktop automatically.

---

## Option B — Browser Setup

### Step 1 — Authenticate

Open the setup URL your admin shared:

```
https://<CODESPACE-URL>/setup
```

Click **Connect Workday Account** and sign in with your Workday credentials.

### Step 2 — Copy Your Config

After authenticating, the page shows a config snippet. Click **Copy to clipboard**.

### Step 3 — Add to Claude Desktop

1. Open Claude Desktop
2. Go to **Settings → Developer → Edit Config**

   Config file locations:
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

3. Paste the `workday` block into the `mcpServers` section:

   ```json
   {
     "mcpServers": {
       "workday": {
         "type": "http",
         "url": "https://<CODESPACE-URL>/mcp/<YOUR-KEY>",
         "headers": {
           "Authorization": "Bearer <YOUR-TOKEN>"
         }
       }
     }
   }
   ```

4. **Restart Claude Desktop** (quit fully, then reopen)

---

## Option C — Local MCP Server (Best Experience)

For automatic token refresh without config editing:

### Step 1 — Clone the project

```bash
git clone <REPO-URL>
cd workday-mcp
npm install
```

### Step 2 — Add to Claude Desktop config

```json
{
  "mcpServers": {
    "workday": {
      "command": "node",
      "args": ["/full/path/to/workday-mcp/mcp-server.mjs"],
      "env": {
        "WORKDAY_TENANT_ID": "your_tenant_id",
        "WORKDAY_BASE_URL": "https://your-workday-host.workday.com",
        "WORKDAY_POC_URL": "https://<CODESPACE-URL>"
      }
    }
  }
}
```

### Step 3 — Restart Claude Desktop and authenticate

In Claude, say:

> "Authenticate with Workday"

A browser window opens. Sign in. Done.

---

## Step 4 — Test It

In Claude Desktop, try:

> "Show me my Workday profile"

or

> "What's in my Workday inbox?"

You should see live data from Workday.

---

## Token Expiry

Workday tokens expire after ~1 hour.

**If using the local MCP server (Option C):** Just say "Authenticate with Workday" again.

**If using HTTP transport (Option B):**
1. Re-visit `https://<CODESPACE-URL>/setup`
2. Click **Connect Workday Account**
3. Copy the new config snippet
4. Replace the token in your Claude Desktop config
5. Restart Claude Desktop

---

## Available Tools

Once connected, Claude can help you with:

| Tool | What it does |
|------|-------------|
| `authenticate_workday` | Sign into Workday (browser opens) |
| `get_my_profile` | Your name, title, department, location |
| `get_my_job_profile` | Job family, level, management level |
| `get_my_manager` | Your manager's details |
| `get_my_direct_reports` | Your direct reports (if any) |
| `get_my_full_summary` | All-in-one snapshot (profile + inbox + time off) |
| `get_my_inbox` | Pending approval tasks |
| `approve_inbox_item` | Approve an inbox task |
| `deny_inbox_item` | Deny an inbox task |
| `get_my_time_off` | Upcoming and recent time-off requests |
| `get_my_time_off_balance` | Current PTO/sick/vacation balances |
| `get_eligible_absence_types` | What time-off types you can request |
| `request_time_off` | Submit a time-off request |
| `get_my_compensation` | Your compensation details |
| `get_my_benefits` | Your benefit elections |
| `get_my_benefit_enrollments` | Detailed benefit breakdown |
| `get_org_chart` | Your org's supervisory structure |
| `get_org_members` | Members of an org |
| `get_orgs_i_manage` | Orgs you manage |
| `search_workers` | Search for a colleague by name |
| `lookup_worker` | Look up a worker by ID |
| `get_my_worker_history` | Your employment history |
| `get_open_positions` | Open positions in your org |
| `request_one_time_payment` | Submit a spot bonus (managers) |
| `get_event_status` | Check a business process event status |

---

## Troubleshooting

**"Tool not found" or no Workday tools appear**
→ Restart Claude Desktop after editing the config.

**"Not authenticated" errors**
→ Call `authenticate_workday` first, or re-authenticate if token expired.

**"Unauthorized" or 401 errors**
→ Token expired. Re-authenticate.

**"403 Forbidden" on a specific tool**
→ Your Workday security role doesn't permit that action. The tool works — you need the right access in Workday.

**Tools return empty results**
→ The Codespace may have been paused. Ask your admin to restart the server.

---

## Questions?

Contact your Workday MCP administrator.
