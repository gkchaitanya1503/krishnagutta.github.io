#!/usr/bin/env node
/**
 * Workday MCP Server — Local stdio transport for Claude Desktop
 *
 * Runs locally on the user's machine. Relays OAuth through a Codespace
 * server (WORKDAY_POC_URL) since Workday requires HTTPS redirect URIs.
 *
 * Architecture:
 *   User → Claude Desktop → this process (stdio) → Codespace relay → Workday
 *
 * Non-blocking auth:
 *   The MCP stdio transport times out if a tool handler blocks for > ~30s.
 *   `authenticate_workday` returns immediately; token polling runs in the
 *   background and stores the token in `accessToken` when ready.
 *
 * Required env (set in claude_desktop_config.json):
 *   WORKDAY_TENANT_ID — your Workday tenant ID
 *   WORKDAY_BASE_URL  — e.g. https://wd5-impl-services1.workday.com
 *   WORKDAY_POC_URL   — e.g. https://my-codespace-4000.app.github.dev
 *
 * Optional:
 *   WORKDAY_ACCESS_TOKEN — skip browser auth if you have a token already
 */

import { McpServer }             from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport }  from '@modelcontextprotocol/sdk/server/stdio.js';
import { z }                     from 'zod';
import axios                     from 'axios';
import { randomUUID }            from 'crypto';
import open                      from 'open';

// ─── Config ───────────────────────────────────────────────────────────────────

const {
  WORKDAY_TENANT_ID: TENANT,
  WORKDAY_BASE_URL:  WORKDAY_BASE,
  WORKDAY_POC_URL,
} = process.env;

const missing = ['WORKDAY_TENANT_ID', 'WORKDAY_BASE_URL', 'WORKDAY_POC_URL']
  .filter(k => !process.env[k]);
if (missing.length) {
  process.stderr.write(`[workday-mcp] Missing config: ${missing.join(', ')}\n`);
  process.exit(1);
}

const POC_URL = WORKDAY_POC_URL.replace(/\/$/, '');

// Workday REST API base URLs (by functional area)
const BASE              = `${WORKDAY_BASE}/ccx/api/v1/${TENANT}`;
const BASE_ABSENCE      = `${WORKDAY_BASE}/ccx/api/absenceManagement/v4/${TENANT}`;
const BASE_BP           = `${WORKDAY_BASE}/ccx/api/businessProcess/v1/${TENANT}`;
const BASE_STAFFING     = `${WORKDAY_BASE}/ccx/api/staffing/v7/${TENANT}`;
const BASE_COMMON       = `${WORKDAY_BASE}/ccx/api/common/v1/${TENANT}`;
const BASE_COMPENSATION = `${WORKDAY_BASE}/ccx/api/compensation/v3/${TENANT}`;
const BASE_PAYROLL      = `${WORKDAY_BASE}/ccx/api/payroll/v2/${TENANT}`;

// ─── State ────────────────────────────────────────────────────────────────────

let accessToken           = process.env.WORKDAY_ACCESS_TOKEN || null;
let backgroundAuthPromise = null;
let lastAuthError         = null;

process.stderr.write(`[workday-mcp] Starting — tenant: ${TENANT}\n`);
process.stderr.write(accessToken
  ? `[workday-mcp] Token pre-loaded from config\n`
  : `[workday-mcp] No token — call authenticate_workday to sign in\n`);

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function pollForToken(sessionKey, timeoutMs = 300_000) {
  const url = `${POC_URL}/session/${sessionKey}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const data = await r.json();
        if (data.access_token) return data.access_token;
      }
    } catch {
      // Retry after delay
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Authentication timeout — user did not complete sign-in within 5 minutes');
}

async function startAuthFlow() {
  const sessionKey = randomUUID();
  const loginUrl   = `${POC_URL}/oauth/login?relay=${sessionKey}`;

  try { await open(loginUrl); }
  catch { /* best-effort — user can still copy from the tool response */ }

  // Background poll — do NOT await (blocking would kill stdio transport)
  backgroundAuthPromise = pollForToken(sessionKey, 300_000)
    .then(token => {
      accessToken = token;
      lastAuthError = null;
      backgroundAuthPromise = null;
      process.stderr.write(`[workday-mcp] Auth complete — token received\n`);
    })
    .catch(err => {
      lastAuthError = err.message;
      backgroundAuthPromise = null;
      process.stderr.write(`[workday-mcp] Auth failed: ${err.message}\n`);
    });

  return loginUrl;
}

// ─── API Helpers ──────────────────────────────────────────────────────────────

function authHeaders() {
  return { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
}

function handleAxiosError(e, url) {
  if (e.response?.status === 401) {
    accessToken = null;
    process.stderr.write('[workday-mcp] Token expired — call authenticate_workday again\n');
  }
  process.stderr.write(`[workday-mcp] ERROR ${e.response?.status || '?'} on ${url}: ${JSON.stringify(e.response?.data || e.message)}\n`);
  return {
    ok:     false,
    status: e.response?.status,
    error:  e.response?.data ?? e.message,
  };
}

async function wd(path, base = BASE) {
  if (!accessToken) return { ok: false, status: 401, error: 'Not authenticated. Call authenticate_workday first.' };
  const url = `${base}${path}`;
  try {
    const r = await axios.get(url, { headers: authHeaders() });
    return { ok: true, status: r.status, data: r.data };
  } catch (e) {
    return handleAxiosError(e, url);
  }
}

async function wdPost(path, body, base = BASE) {
  if (!accessToken) return { ok: false, status: 401, error: 'Not authenticated. Call authenticate_workday first.' };
  const url = `${base}${path}`;
  try {
    const r = await axios.post(url, body, {
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    });
    return { ok: true, status: r.status, data: r.data };
  } catch (e) {
    return handleAxiosError(e, url);
  }
}

function formatResult(label, result) {
  if (!result.ok) {
    return `${label} failed (${result.status || 'error'}): ${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}`;
  }
  return `${label}:\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``;
}

function toText(label, result) {
  return { content: [{ type: 'text', text: formatResult(label, result) }] };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    'workday-mcp-server',
  version: '0.1.0-poc',
});

// ── Auth tools ───────────────────────────────────────────────────────────────

server.tool(
  'authenticate_workday',
  'Sign in to Workday via browser using OAuth 2.0 with PKCE. Opens your browser to the Workday login page; after signing in, the access token is automatically relayed back. Returns immediately; the token becomes available in the background.',
  {},
  async () => {
    const loginUrl = await startAuthFlow();
    return {
      content: [{
        type: 'text',
        text:
          `Browser opened — please sign in with your Workday credentials.\n\n` +
          `If the browser did not open automatically, visit:\n${loginUrl}\n\n` +
          `Once you sign in, authentication will complete automatically. ` +
          `Call check_auth_status after ~30 seconds to confirm, or just call another tool.`,
      }],
    };
  }
);

server.tool(
  'check_auth_status',
  'Check whether you are currently authenticated with Workday.',
  {},
  async () => {
    if (accessToken) {
      return { content: [{ type: 'text', text: '✅ Authenticated — ready to query Workday.' }] };
    }
    if (backgroundAuthPromise) {
      return { content: [{ type: 'text', text: '⏳ Authentication in progress. Complete sign-in in your browser.' }] };
    }
    if (lastAuthError) {
      return { content: [{ type: 'text', text: `❌ Not authenticated. Last error: ${lastAuthError}` }] };
    }
    return { content: [{ type: 'text', text: 'Not authenticated. Call authenticate_workday to sign in.' }] };
  }
);

// ── Profile ──────────────────────────────────────────────────────────────────

server.tool(
  'get_my_profile',
  'Get the authenticated user\'s Workday profile (name, title, department, location, manager).',
  {},
  async () => toText('Profile', await wd('/workers/me'))
);

server.tool(
  'get_my_job_profile',
  'Get the authenticated user\'s job profile (job family, management level, job category).',
  {},
  async () => toText('Job Profile', await wd('/workers/me?expand=jobProfile'))
);

server.tool(
  'get_my_manager',
  'Get the authenticated user\'s manager details.',
  {},
  async () => toText('Manager', await wd('/workers/me/supervisor'))
);

server.tool(
  'get_my_full_summary',
  'All-in-one snapshot: profile + inbox + time-off balance.',
  {},
  async () => {
    const [profile, inbox, balance] = await Promise.all([
      wd('/workers/me'),
      wd('/workers/me/inboxTasks'),
      wd('/workers/me/timeOffBalances', BASE_ABSENCE),
    ]);
    return {
      content: [{
        type: 'text',
        text: [
          formatResult('Profile', profile),
          formatResult('Inbox', inbox),
          formatResult('Time-off balance', balance),
        ].join('\n\n'),
      }],
    };
  }
);

// ── Organization ─────────────────────────────────────────────────────────────

server.tool(
  'get_org_chart',
  'Get the supervisory organization hierarchy for the authenticated user\'s org.',
  {},
  async () => toText('Org Chart', await wd('/workers/me/supervisoryOrganization', BASE_STAFFING))
);

server.tool(
  'get_org_members',
  'Get the members of a supervisory organization by ID.',
  {
    orgId: z.string().describe('Supervisory organization ID'),
  },
  async ({ orgId }) => toText('Org Members',
    await wd(`/supervisoryOrganizations/${orgId}/members`, BASE_STAFFING))
);

server.tool(
  'get_my_direct_reports',
  'Get direct reports of the authenticated user (managers only).',
  {},
  async () => toText('Direct Reports', await wd('/workers/me/directReports'))
);

server.tool(
  'get_orgs_i_manage',
  'Get supervisory organizations managed by the authenticated user.',
  {},
  async () => toText('Managed Orgs', await wd('/workers/me/managedOrganizations', BASE_STAFFING))
);

// ── Search & Lookup ──────────────────────────────────────────────────────────

server.tool(
  'search_workers',
  'Search for workers by name. Returns a list of matching workers with ID and descriptor.',
  {
    name:  z.string().describe('Name or partial name to search for'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10)'),
  },
  async ({ name, limit = 10 }) =>
    toText('Workers', await wd(`/workers?search=${encodeURIComponent(name)}&limit=${limit}`))
);

server.tool(
  'lookup_worker',
  'Get a worker\'s public profile by Worker ID (no PII).',
  {
    workerId: z.string().describe('Worker ID'),
  },
  async ({ workerId }) => toText('Worker', await wd(`/workers/${workerId}`))
);

// ── Time Off ─────────────────────────────────────────────────────────────────

server.tool(
  'get_my_time_off',
  'Get the authenticated user\'s upcoming and recent time-off requests.',
  {},
  async () => toText('Time Off Requests',
    await wd('/workers/me/absenceEvents', BASE_ABSENCE))
);

server.tool(
  'get_my_time_off_balance',
  'Get the authenticated user\'s current time-off balances.',
  {},
  async () => toText('Time Off Balances',
    await wd('/workers/me/timeOffBalances', BASE_ABSENCE))
);

server.tool(
  'get_eligible_absence_types',
  'Get the absence types the authenticated user is eligible to request.',
  {},
  async () => toText('Eligible Absence Types',
    await wd('/workers/me/eligibleAbsenceTypes', BASE_ABSENCE))
);

server.tool(
  'request_time_off',
  'Submit a time-off request.',
  {
    absenceTypeId: z.string().describe('Absence type ID (from get_eligible_absence_types)'),
    startDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start date YYYY-MM-DD'),
    endDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('End date YYYY-MM-DD'),
    hoursPerDay:   z.number().min(0.25).max(24).optional().describe('Hours per day (default 8)'),
    comment:       z.string().optional().describe('Optional comment'),
  },
  async ({ absenceTypeId, startDate, endDate, hoursPerDay = 8, comment }) => {
    const body = {
      absenceType: { id: absenceTypeId },
      days: [{
        start:         startDate,
        end:           endDate,
        dailyQuantity: hoursPerDay,
      }],
    };
    if (comment) body.comment = comment;
    return toText('Time Off Request',
      await wdPost('/workers/me/requestTimeOff', body, BASE_ABSENCE));
  }
);

// ── Compensation & Benefits ──────────────────────────────────────────────────

server.tool(
  'get_my_compensation',
  'Get the authenticated user\'s current compensation details.',
  {},
  async () => toText('Compensation', await wd('/workers/me/compensation', BASE_COMPENSATION))
);

server.tool(
  'get_my_benefits',
  'Get the authenticated user\'s benefit elections (healthcare, retirement, etc.).',
  {},
  async () => toText('Benefit Elections', await wd('/workers/me/benefitElections'))
);

// ── Inbox ────────────────────────────────────────────────────────────────────

server.tool(
  'get_my_inbox',
  'Get pending approval tasks in the authenticated user\'s Workday inbox.',
  {},
  async () => toText('Inbox', await wd('/workers/me/inboxTasks'))
);

server.tool(
  'approve_inbox_item',
  'Approve an inbox task by event ID.',
  {
    eventId: z.string().describe('Business process event ID'),
    comment: z.string().optional().describe('Optional approval comment'),
  },
  async ({ eventId, comment }) => toText('Approve',
    await wdPost(`/inboxTasks/${eventId}/approve`, { comment }, BASE_BP))
);

server.tool(
  'deny_inbox_item',
  'Deny an inbox task by event ID. Comment is required.',
  {
    eventId: z.string().describe('Business process event ID'),
    comment: z.string().describe('Denial reason'),
  },
  async ({ eventId, comment }) => toText('Deny',
    await wdPost(`/inboxTasks/${eventId}/deny`, { comment }, BASE_BP))
);

// ── History & Events ─────────────────────────────────────────────────────────

server.tool(
  'get_my_worker_history',
  'Get the authenticated user\'s employment history and role changes.',
  {},
  async () => toText('Worker History', await wd('/workers/me/history'))
);

server.tool(
  'get_event_status',
  'Check the status of a business process event.',
  {
    eventId: z.string().describe('Business process event ID'),
  },
  async ({ eventId }) => toText('Event Status',
    await wd(`/businessProcesses/${eventId}`, BASE_BP))
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[workday-mcp] Running on stdio (relay: ${POC_URL})\n`);
