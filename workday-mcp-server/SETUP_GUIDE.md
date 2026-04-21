# Workday MCP Server — End User Setup Guide

Connect Claude Desktop to your Workday tenant in ~3 minutes.

---

## Prerequisites

- [Claude Desktop](https://claude.ai/download) installed
- Your Workday credentials (SSO or username/password)
- A Codespace relay URL from your admin (e.g. `https://my-codespace-4000.app.github.dev`)

---

## Step 1 — Authenticate

Open the setup page your admin shared:

```
https://<CODESPACE-RELAY-URL>/setup
```

Click **Connect Workday Account** and complete the login flow. Workday redirects you back automatically.

---

## Step 2 — Copy your config

After authenticating, the success page shows a config snippet like:

```json
{
  "mcpServers": {
    "workday": {
      "type": "http",
      "url": "https://<CODESPACE-RELAY-URL>/mcp/<YOUR-USER-KEY>",
      "headers": {
        "Authorization": "Bearer <YOUR-TOKEN>"
      }
    }
  }
}
```

Click **Copy** to copy it to your clipboard.

---

## Step 3 — Add to Claude Desktop

1. Open Claude Desktop
2. **Settings → Developer → Edit Config** (or open the file directly)

   | Platform | Config Path |
   |---|---|
   | macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
   | Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
   | Linux | `~/.config/Claude/claude_desktop_config.json` |

3. Merge the `workday` block into the `mcpServers` section of your config. **Do not replace the whole file** if you already have other MCP servers:

   ```json
   {
     "mcpServers": {
       "some-other-server": { },
       "workday": {
         "type": "http",
         "url": "https://<CODESPACE-RELAY-URL>/mcp/<YOUR-USER-KEY>",
         "headers": {
           "Authorization": "Bearer <YOUR-TOKEN>"
         }
       }
     }
   }
   ```

4. **Restart Claude Desktop** (quit fully, then reopen)

---

## Step 4 — Test it

In Claude Desktop, try:

> "Show me my Workday profile"

or

> "What's in my Workday inbox?"

You should see live data from Workday.

---

## Alternative: stdio mode (`mcp-server.mjs` runs locally)

If your admin prefers you to run the MCP server locally instead of via HTTP transport, use the bundled `setup.js` script:

```bash
git clone https://github.com/gkchaitanya1503/workday-oauth-poc.git
cd workday-oauth-poc
node setup.js
```

The script will prompt for the Codespace URL, your tenant ID, and base URL, and write the config automatically. The first time Claude calls `authenticate_workday`, a browser tab opens for sign-in — no token copying needed.

---

## Token Expiry

Workday access tokens expire after ~60 minutes. When Claude returns auth errors:

- **HTTP transport:** revisit `/setup`, click **Re-authenticate**, copy the new config, update Claude Desktop config, restart.
- **stdio transport:** just say "Authenticate with Workday" — the server opens a browser and refreshes automatically.

---

## Available Tools

| Tool | Description |
|------|-------------|
| `authenticate_workday` | Sign in via browser (stdio mode only) |
| `check_auth_status` | Check current authentication state |
| `get_my_profile` | Your name, title, department, location |
| `get_my_job_profile` | Job family, level, management level |
| `get_my_manager` | Your manager's details |
| `get_my_direct_reports` | Your direct reports (if any) |
| `get_my_inbox` | Pending approval tasks in your Workday inbox |
| `approve_inbox_item` | Approve an inbox task by ID |
| `deny_inbox_item` | Deny an inbox task by ID |
| `get_my_time_off` | Upcoming and recent time-off requests |
| `get_my_time_off_balance` | Current time-off balances |
| `get_eligible_absence_types` | Time-off types you can request |
| `request_time_off` | Submit a time-off request |
| `get_my_compensation` | Your current compensation |
| `get_my_benefits` | Your benefit elections |
| `get_org_chart` | Supervisory org structure |
| `get_org_members` | Members of an org by ID |
| `get_orgs_i_manage` | Orgs you manage |
| `search_workers` | Search colleagues by name |
| `lookup_worker` | Get a worker's public profile by ID |
| `get_my_worker_history` | Your employment history |
| `get_my_full_summary` | All-in-one snapshot |
| `get_event_status` | Check a business process event status |

---

## Troubleshooting

**No Workday tools appear in Claude Desktop**
→ Make sure you restarted Claude Desktop after editing the config. Check the config file for valid JSON.

**"Unauthorized" or 401 errors**
→ Token expired. Re-authenticate (see [Token Expiry](#token-expiry)).

**"403 Forbidden" on a specific tool**
→ Your Workday security role doesn't permit that action. Contact your Workday admin to grant the right functional area access.

**Tools appear but return empty results**
→ The Codespace may have been paused. Contact your admin to restart it.

**"Authentication timeout" from `authenticate_workday`**
→ You didn't complete sign-in within 5 minutes. Call the tool again.

---

## Questions?

Contact your Workday administrator or the team that set up this MCP server.
