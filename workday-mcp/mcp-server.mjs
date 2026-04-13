#!/usr/bin/env node
/**
 * Workday MCP Server — Local stdio transport for Claude Desktop
 *
 * Runs on the user's machine. Communicates with Claude Desktop via stdio.
 * Authenticates via browser → Codespace relay → token polling.
 *
 * Claude Desktop config (claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "workday": {
 *       "command": "node",
 *       "args": ["/path/to/mcp-server.mjs"],
 *       "env": {
 *         "WORKDAY_TENANT_ID": "your_tenant",
 *         "WORKDAY_BASE_URL": "https://wd5-impl-services1.workday.com",
 *         "WORKDAY_POC_URL": "https://<codespace>-4000.app.github.dev"
 *       }
 *     }
 *   }
 * }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import crypto from 'crypto';

// ── Config ────────────────────────────────────────────────────────────────────

const TENANT       = process.env.WORKDAY_TENANT_ID || '';
const WD_BASE      = process.env.WORKDAY_BASE_URL  || '';
const CODESPACE_URL = process.env.WORKDAY_POC_URL  || '';

const BASE              = `${WD_BASE}/ccx/api/v1/${TENANT}`;
const BASE_ABSENCE      = `${WD_BASE}/ccx/api/absenceManagement/v4/${TENANT}`;
const BASE_BP           = `${WD_BASE}/ccx/api/businessProcess/v1/${TENANT}`;
const BASE_STAFFING     = `${WD_BASE}/ccx/api/staffing/v7/${TENANT}`;
const BASE_COMPENSATION = `${WD_BASE}/ccx/api/compensation/v3/${TENANT}`;
const BASE_PAYROLL      = `${WD_BASE}/ccx/api/payroll/v2/${TENANT}`;
const SOAP_BASE         = `${WD_BASE}/ccx/service/${TENANT}`;

// ── State ─────────────────────────────────────────────────────────────────────

let accessToken = process.env.WORKDAY_ACCESS_TOKEN || null;
let backgroundAuthPromise = null;

// ── API Helper ────────────────────────────────────────────────────────────────

async function wd(path, base = BASE, options = {}) {
  if (!accessToken) {
    return { ok: false, status: 401, error: 'Not authenticated. Call authenticate_workday first.' };
  }
  try {
    const url = `${base}${path}`;
    const r = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': options.contentType || 'application/json',
        Accept: 'application/json',
        ...options.headers,
      },
      body: options.body || undefined,
    });
    if (r.status === 401) {
      accessToken = null;
      return { ok: false, status: 401, error: 'Token expired. Call authenticate_workday to re-authenticate.' };
    }
    if (!r.ok) {
      const text = await r.text();
      return { ok: false, status: r.status, error: text };
    }
    const contentType = r.headers.get('content-type') || '';
    if (contentType.includes('json')) {
      return { ok: true, data: await r.json() };
    }
    return { ok: true, data: await r.text() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function wdSoap(service, version, body) {
  if (!accessToken) {
    return { ok: false, error: 'Not authenticated. Call authenticate_workday first.' };
  }
  try {
    const url = `${SOAP_BASE}/${service}/${version}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'text/xml;charset=UTF-8',
      },
      body,
    });
    if (r.status === 401) { accessToken = null; return { ok: false, status: 401 }; }
    const text = await r.text();
    if (!r.ok) return { ok: false, status: r.status, error: text };
    return { ok: true, data: text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Simple XML text extractors
function xmlAll(xml, tag) {
  const re = new RegExp(`<[^:]*:${tag}[^>]*>([\\s\\S]*?)<\\/[^:]*:${tag}>`, 'gi');
  return [...xml.matchAll(re)].map(m => m[1].trim());
}

function xmlFirst(xml, tag) {
  const m = xml.match(new RegExp(`<[^:]*:${tag}[^>]*>([\\s\\S]*?)<\\/[^:]*:${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

function xmlDescriptor(xml) {
  return xmlFirst(xml, 'Descriptor') || xmlFirst(xml, 'descriptor');
}

// ── Token Polling ─────────────────────────────────────────────────────────────

async function pollForToken(sessionKey, timeoutMs = 300_000) {
  const url = `${CODESPACE_URL}/session/${sessionKey}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const data = await r.json();
        if (data.access_token) return data.access_token;
      }
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Authentication timed out after 5 minutes.');
}

// ── Result Helpers ────────────────────────────────────────────────────────────

function txt(text) {
  return { content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }] };
}

function err(msg) {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

function requireAuth() {
  if (!accessToken) return err('Not authenticated. Please call the authenticate_workday tool first.');
  return null;
}

// ── Tool Definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  // ── Auth ──
  {
    name: 'authenticate_workday',
    description: 'Open a browser window to sign into Workday with your credentials. Returns immediately — sign in will complete in the background.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // ── Profile & Identity ──
  {
    name: 'get_my_profile',
    description: 'Get your Workday profile: name, title, department, location, email, manager, hire date.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_my_job_profile',
    description: 'Get your job profile details: job family, management level, job category, time type.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_my_manager',
    description: 'Get your current manager\'s name, title, email, and worker ID.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_my_full_summary',
    description: 'All-in-one snapshot: profile + inbox count + upcoming time off. Good for daily standup prep.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // ── Organization ──
  {
    name: 'get_org_chart',
    description: 'Get the supervisory organization hierarchy for a worker. Defaults to your own org.',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'Worker ID (optional, defaults to "me")' },
      },
    },
  },
  {
    name: 'get_org_members',
    description: 'List members of a supervisory organization by org ID.',
    inputSchema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Supervisory organization ID' },
      },
      required: ['org_id'],
    },
  },
  {
    name: 'get_my_direct_reports',
    description: 'List your direct reports (for managers). Shows name, title, email for each.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_orgs_i_manage',
    description: 'List supervisory organizations you manage (for managers and HRBPs).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_worker_organizations',
    description: 'Get all organizations a worker belongs to.',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'Worker ID (optional, defaults to "me")' },
      },
    },
  },
  // ── Search & Lookup ──
  {
    name: 'search_workers',
    description: 'Search for colleagues by name. Returns matching workers with name, title, and ID.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name to search for (first, last, or full)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lookup_worker',
    description: 'Look up a specific worker by their Workday ID. Returns public profile fields only.',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'Workday worker ID' },
      },
      required: ['worker_id'],
    },
  },
  // ── Time Off & Absence ──
  {
    name: 'get_my_time_off',
    description: 'Get your upcoming and recent time-off requests with status and dates.',
    inputSchema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', description: 'How many days back to look (default 30)' },
        days_forward: { type: 'number', description: 'How many days forward to look (default 90)' },
      },
    },
  },
  {
    name: 'get_my_time_off_balance',
    description: 'Get your current time-off balances (vacation, sick, personal, etc.).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_eligible_absence_types',
    description: 'List the types of time off you can request (vacation, sick, personal, etc.).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'request_time_off',
    description: 'Submit a time-off request. Specify the absence type, start date, and end date.',
    inputSchema: {
      type: 'object',
      properties: {
        absence_type_id: { type: 'string', description: 'Absence type ID (get from get_eligible_absence_types)' },
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
        comment: { type: 'string', description: 'Optional comment for the request' },
      },
      required: ['absence_type_id', 'start_date', 'end_date'],
    },
  },
  // ── Compensation & Benefits ──
  {
    name: 'get_my_compensation',
    description: 'Get your current compensation details including base pay and total compensation.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_my_benefits',
    description: 'Get your current benefit elections (healthcare, dental, vision, retirement, etc.).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_my_benefit_enrollments',
    description: 'Get detailed benefit enrollment information via SOAP API. Includes coverage levels, dependents, and plan details.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // ── Inbox & Actions ──
  {
    name: 'get_my_inbox',
    description: 'Get your Workday inbox — pending approval tasks, notifications, and action items.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max items to return (default 20)' },
      },
    },
  },
  {
    name: 'approve_inbox_item',
    description: 'Approve a pending inbox item by its event/step ID.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The business process event or step ID to approve' },
        comment: { type: 'string', description: 'Optional approval comment' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'deny_inbox_item',
    description: 'Deny a pending inbox item by its event/step ID.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The business process event or step ID to deny' },
        reason: { type: 'string', description: 'Reason for denial' },
      },
      required: ['event_id'],
    },
  },
  // ── Career & History ──
  {
    name: 'get_my_worker_history',
    description: 'Get your employment history: role changes, promotions, transfers, and title changes.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by category: "job", "compensation", "all" (default "all")' },
      },
    },
  },
  {
    name: 'get_open_positions',
    description: 'Get open positions in your supervisory organization or a specified org.',
    inputSchema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Supervisory org ID (optional, defaults to your org)' },
      },
    },
  },
  // ── Manager Actions ──
  {
    name: 'request_one_time_payment',
    description: 'Submit a one-time payment or spot bonus for a worker (managers only). Uses SOAP API.',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'Worker ID of the recipient' },
        amount: { type: 'number', description: 'Payment amount' },
        currency: { type: 'string', description: 'Currency code (default "USD")' },
        reason: { type: 'string', description: 'Reason for the payment' },
      },
      required: ['worker_id', 'amount'],
    },
  },
  {
    name: 'get_event_status',
    description: 'Check the status of a Workday business process event by event ID.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Business process event ID' },
      },
      required: ['event_id'],
    },
  },
];

// ── Tool Handlers ─────────────────────────────────────────────────────────────

const handlers = {
  // ── Auth ──
  async authenticate_workday() {
    if (!CODESPACE_URL) {
      return err('WORKDAY_POC_URL environment variable not set. Point it to your Codespace relay URL.');
    }
    if (accessToken) {
      // Verify token still works
      const check = await wd('/workers/me');
      if (check.ok) {
        const name = check.data?.data?.[0]?.descriptor || check.data?.descriptor || '';
        return txt(`Already authenticated${name ? ` as ${name}` : ''}. Token is valid.`);
      }
      accessToken = null;
    }

    const sessionKey = crypto.randomUUID();
    const loginUrl = `${CODESPACE_URL}/oauth/login?relay=${sessionKey}`;

    // Open browser — dynamic import for ESM compatibility
    try {
      const { default: open } = await import('open');
      await open(loginUrl);
    } catch {
      return txt(`Could not open browser automatically.\n\nOpen this URL manually:\n${loginUrl}`);
    }

    // Background poll — does NOT block the tool response
    backgroundAuthPromise = pollForToken(sessionKey, 300_000)
      .then(token => { accessToken = token; backgroundAuthPromise = null; })
      .catch(() => { backgroundAuthPromise = null; });

    return txt(
      'Browser opened — sign in with your Workday credentials.\n\n' +
      'Authentication will complete automatically in the background. ' +
      'Wait about 10-15 seconds after signing in, then try any Workday tool.'
    );
  },

  // ── Profile & Identity ──
  async get_my_profile() {
    const auth = requireAuth(); if (auth) return auth;
    const r = await wd('/workers/me');
    if (!r.ok) return err(r.error);
    const w = r.data?.data?.[0] || r.data;
    return txt(w);
  },

  async get_my_job_profile() {
    const auth = requireAuth(); if (auth) return auth;
    const r = await wd('/workers/me?expand=jobProfile');
    if (!r.ok) return err(r.error);
    return txt(r.data?.data?.[0] || r.data);
  },

  async get_my_manager() {
    const auth = requireAuth(); if (auth) return auth;
    const r = await wd('/workers/me?expand=manager');
    if (!r.ok) return err(r.error);
    const w = r.data?.data?.[0] || r.data;
    const mgr = w?.primarySupervisoryOrganization?.manager || w?.manager;
    if (mgr) return txt(mgr);
    // Fallback: try staffing API
    const r2 = await wd('/workers/me/managers', BASE_STAFFING);
    if (r2.ok) return txt(r2.data);
    return txt(w);
  },

  async get_my_full_summary() {
    const auth = requireAuth(); if (auth) return auth;
    const [profile, inbox, timeOff] = await Promise.all([
      wd('/workers/me'),
      wd('/workers/me/inbox'),
      wd('/workers/me/timeOffEntries', BASE_ABSENCE),
    ]);

    const summary = {
      profile: profile.ok ? (profile.data?.data?.[0] || profile.data) : 'Could not fetch profile',
      inbox: inbox.ok ? { count: inbox.data?.total || inbox.data?.data?.length || 0, items: (inbox.data?.data || []).slice(0, 5) } : 'Could not fetch inbox',
      upcomingTimeOff: timeOff.ok ? (timeOff.data?.data || []).slice(0, 5) : 'Could not fetch time off',
    };
    return txt(summary);
  },

  // ── Organization ──
  async get_org_chart({ worker_id }) {
    const auth = requireAuth(); if (auth) return auth;
    const wid = worker_id || 'me';
    const r = await wd(`/workers/${wid}/supervisoryOrganizationsManaged`, BASE_STAFFING);
    if (r.ok) return txt(r.data);
    // Fallback
    const r2 = await wd(`/workers/${wid}?expand=supervisoryOrganization`);
    if (r2.ok) return txt(r2.data?.data?.[0] || r2.data);
    return err(r.error || r2.error);
  },

  async get_org_members({ org_id }) {
    const auth = requireAuth(); if (auth) return auth;
    const r = await wd(`/supervisoryOrganizations/${org_id}/members`, BASE_STAFFING);
    if (!r.ok) return err(r.error);
    return txt(r.data);
  },

  async get_my_direct_reports() {
    const auth = requireAuth(); if (auth) return auth;
    const r = await wd('/workers/me/directReports', BASE_STAFFING);
    if (r.ok) return txt(r.data);
    // Fallback: get orgs I manage then list members
    const r2 = await wd('/workers/me?expand=directReports');
    if (r2.ok) return txt(r2.data?.data?.[0]?.directReports || r2.data);
    return err(r.error);
  },

  async get_orgs_i_manage() {
    const auth = requireAuth(); if (auth) return auth;
    const r = await wd('/workers/me/supervisoryOrganizationsManaged', BASE_STAFFING);
    if (!r.ok) return err(r.error);
    return txt(r.data);
  },

  async get_worker_organizations({ worker_id }) {
    const auth = requireAuth(); if (auth) return auth;
    const wid = worker_id || 'me';
    const r = await wd(`/workers/${wid}/organizations`);
    if (!r.ok) return err(r.error);
    return txt(r.data);
  },

  // ── Search & Lookup ──
  async search_workers({ query, limit }) {
    const auth = requireAuth(); if (auth) return auth;
    const max = limit || 10;
    const r = await wd(`/workers?search=${encodeURIComponent(query)}&limit=${max}`);
    if (!r.ok) return err(r.error);
    const workers = (r.data?.data || []).map(w => ({
      id: w.id,
      descriptor: w.descriptor,
      primaryWorkEmail: w.primaryWorkEmail,
      businessTitle: w.businessTitle,
    }));
    return txt({ count: workers.length, workers });
  },

  async lookup_worker({ worker_id }) {
    const auth = requireAuth(); if (auth) return auth;
    const r = await wd(`/workers/${worker_id}`);
    if (!r.ok) return err(r.error);
    return txt(r.data?.data?.[0] || r.data);
  },

  // ── Time Off & Absence ──
  async get_my_time_off({ days_back, days_forward }) {
    const auth = requireAuth(); if (auth) return auth;
    const from = new Date();
    from.setDate(from.getDate() - (days_back || 30));
    const to = new Date();
    to.setDate(to.getDate() + (days_forward || 90));
    const fromStr = from.toISOString().split('T')[0];
    const toStr = to.toISOString().split('T')[0];
    const r = await wd(`/workers/me/requestedTimeOff?from=${fromStr}&to=${toStr}`, BASE_ABSENCE);
    if (r.ok) return txt(r.data);
    // Fallback to core API
    const r2 = await wd('/workers/me/timeOffEntries');
    if (r2.ok) return txt(r2.data);
    return err(r.error);
  },

  async get_my_time_off_balance() {
    const auth = requireAuth(); if (auth) return auth;
    const r = await wd('/workers/me/timeOffPlanBalances', BASE_ABSENCE);
    if (r.ok) return txt(r.data);
    const r2 = await wd('/workers/me/balances', BASE_ABSENCE);
    if (r2.ok) return txt(r2.data);
    return err(r.error);
  },

  async get_eligible_absence_types() {
    const auth = requireAuth(); if (auth) return auth;
    const r = await wd('/workers/me/eligibleAbsenceTypes', BASE_ABSENCE);
    if (r.ok) return txt(r.data);
    return err(r.error);
  },

  async request_time_off({ absence_type_id, start_date, end_date, comment }) {
    const auth = requireAuth(); if (auth) return auth;
    const body = JSON.stringify({
      days: [{ date: start_date }],
      absenceType: { id: absence_type_id },
      ...(comment ? { comment } : {}),
    });

    // Calculate all dates between start and end
    const dates = [];
    const d = new Date(start_date);
    const endD = new Date(end_date);
    while (d <= endD) {
      dates.push(d.toISOString().split('T')[0]);
      d.setDate(d.getDate() + 1);
    }

    const requestBody = JSON.stringify({
      days: dates.map(date => ({ date })),
      absenceType: { id: absence_type_id },
      ...(comment ? { comment } : {}),
    });

    const r = await wd('/workers/me/requestTimeOff', BASE_ABSENCE, {
      method: 'POST',
      body: requestBody,
    });
    if (!r.ok) return err(r.error);
    return txt({ message: 'Time-off request submitted successfully.', details: r.data });
  },

  // ── Compensation & Benefits ──
  async get_my_compensation() {
    const auth = requireAuth(); if (auth) return auth;
    // Try REST first
    const r = await wd('/workers/me/compensation', BASE_COMPENSATION);
    if (r.ok) return txt(r.data);
    // Fallback to SOAP
    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:wd="urn:com.workday/bsvc">
  <env:Body>
    <wd:Get_Workers_Request wd:version="v44.0">
      <wd:Request_References>
        <wd:Worker_Reference>
          <wd:ID wd:type="WID">CURRENT_USER</wd:ID>
        </wd:Worker_Reference>
      </wd:Request_References>
      <wd:Response_Group>
        <wd:Include_Compensation>true</wd:Include_Compensation>
      </wd:Response_Group>
    </wd:Get_Workers_Request>
  </env:Body>
</env:Envelope>`;
    const sr = await wdSoap('Human_Resources', 'v44.0', soapBody);
    if (!sr.ok) return err(r.error || sr.error);
    // Parse compensation from SOAP response
    const compPlans = xmlAll(sr.data, 'Compensation_Plan_Data');
    if (compPlans.length) {
      const parsed = compPlans.map(p => ({
        plan: xmlDescriptor(p),
        amount: xmlFirst(p, 'Amount') || xmlFirst(p, 'Compensation_Amount'),
        currency: xmlFirst(p, 'Currency_Code') || xmlFirst(p, 'Currency'),
        frequency: xmlFirst(p, 'Frequency') || xmlDescriptor(p),
      }));
      return txt(parsed);
    }
    return txt(sr.data);
  },

  async get_my_benefits() {
    const auth = requireAuth(); if (auth) return auth;
    const r = await wd('/workers/me/benefits');
    if (r.ok) return txt(r.data);
    return err(r.error);
  },

  async get_my_benefit_enrollments() {
    const auth = requireAuth(); if (auth) return auth;
    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:wd="urn:com.workday/bsvc">
  <env:Body>
    <wd:Get_Workers_Request wd:version="v44.0">
      <wd:Request_References>
        <wd:Worker_Reference>
          <wd:ID wd:type="WID">CURRENT_USER</wd:ID>
        </wd:Worker_Reference>
      </wd:Request_References>
      <wd:Response_Group>
        <wd:Include_Benefit_Enrollments>true</wd:Include_Benefit_Enrollments>
      </wd:Response_Group>
    </wd:Get_Workers_Request>
  </env:Body>
</env:Envelope>`;
    const sr = await wdSoap('Human_Resources', 'v44.0', soapBody);
    if (!sr.ok) return err(sr.error);
    const enrollments = xmlAll(sr.data, 'Benefit_Plan_Data');
    if (enrollments.length) {
      const parsed = enrollments.map(e => ({
        plan: xmlDescriptor(e),
        coverageLevel: xmlFirst(e, 'Coverage_Level') || xmlDescriptor(e),
        cost: xmlFirst(e, 'Employee_Cost') || xmlFirst(e, 'Cost'),
      }));
      return txt(parsed);
    }
    return txt(sr.data);
  },

  // ── Inbox & Actions ──
  async get_my_inbox({ limit }) {
    const auth = requireAuth(); if (auth) return auth;
    const max = limit || 20;
    const r = await wd(`/workers/me/inbox?limit=${max}`);
    if (r.ok) return txt(r.data);
    // Try business process API
    const r2 = await wd('/inbox', BASE_BP);
    if (r2.ok) return txt(r2.data);
    return err(r.error);
  },

  async approve_inbox_item({ event_id, comment }) {
    const auth = requireAuth(); if (auth) return auth;
    const body = JSON.stringify({
      action: 'approve',
      ...(comment ? { comment } : {}),
    });
    const r = await wd(`/steps/${event_id}/approve`, BASE_BP, {
      method: 'POST',
      body,
    });
    if (!r.ok) return err(r.error);
    return txt({ message: 'Inbox item approved successfully.', details: r.data });
  },

  async deny_inbox_item({ event_id, reason }) {
    const auth = requireAuth(); if (auth) return auth;
    const body = JSON.stringify({
      action: 'deny',
      ...(reason ? { comment: reason } : {}),
    });
    const r = await wd(`/steps/${event_id}/deny`, BASE_BP, {
      method: 'POST',
      body,
    });
    if (!r.ok) return err(r.error);
    return txt({ message: 'Inbox item denied.', details: r.data });
  },

  // ── Career & History ──
  async get_my_worker_history({ category }) {
    const auth = requireAuth(); if (auth) return auth;
    const cat = category || 'all';
    let path = '/workers/me/history';
    if (cat === 'job') path = '/workers/me/history/jobs';
    if (cat === 'compensation') path = '/workers/me/history/compensation';
    const r = await wd(path, BASE_STAFFING);
    if (r.ok) return txt(r.data);
    // Fallback
    const r2 = await wd('/workers/me/workerHistory');
    if (r2.ok) return txt(r2.data);
    return err(r.error);
  },

  async get_open_positions({ org_id }) {
    const auth = requireAuth(); if (auth) return auth;
    let path = '/positions?status=open';
    if (org_id) path += `&supervisoryOrganization=${encodeURIComponent(org_id)}`;
    const r = await wd(path, BASE_STAFFING);
    if (!r.ok) return err(r.error);
    return txt(r.data);
  },

  // ── Manager Actions ──
  async request_one_time_payment({ worker_id, amount, currency, reason }) {
    const auth = requireAuth(); if (auth) return auth;
    const cur = currency || 'USD';
    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:wd="urn:com.workday/bsvc">
  <env:Body>
    <wd:Request_One_Time_Payment_Request wd:version="v46.0">
      <wd:Business_Process_Parameters>
        <wd:Auto_Complete>false</wd:Auto_Complete>
        <wd:Run_Now>false</wd:Run_Now>
      </wd:Business_Process_Parameters>
      <wd:Request_One_Time_Payment_Data>
        <wd:Worker_Reference>
          <wd:ID wd:type="Workday_ID">${worker_id}</wd:ID>
        </wd:Worker_Reference>
        <wd:One_Time_Payment_Data>
          <wd:Amount>${amount}</wd:Amount>
          <wd:Currency_Reference>
            <wd:ID wd:type="Currency_ID">${cur}</wd:ID>
          </wd:Currency_Reference>
          ${reason ? `<wd:One_Time_Payment_Reason_Reference>
            <wd:ID wd:type="One-Time_Payment_Reason_ID">${reason}</wd:ID>
          </wd:One_Time_Payment_Reason_Reference>` : ''}
        </wd:One_Time_Payment_Data>
      </wd:Request_One_Time_Payment_Data>
    </wd:Request_One_Time_Payment_Request>
  </env:Body>
</env:Envelope>`;
    const r = await wdSoap('Payroll', 'v46.0', soapBody);
    if (!r.ok) return err(r.error);
    const eventId = xmlFirst(r.data, 'Event_ID') || xmlFirst(r.data, 'id');
    return txt({
      message: 'One-time payment request submitted.',
      eventId,
      worker: worker_id,
      amount: `${amount} ${cur}`,
    });
  },

  async get_event_status({ event_id }) {
    const auth = requireAuth(); if (auth) return auth;
    const r = await wd(`/events/${event_id}`, BASE_BP);
    if (!r.ok) return err(r.error);
    return txt(r.data);
  },
};

// ── MCP Server Setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'workday-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = handlers[name];
  if (!handler) {
    return err(`Unknown tool: ${name}`);
  }
  try {
    return await handler(args || {});
  } catch (e) {
    return err(`Tool ${name} failed: ${e.message}`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Workday MCP Server (stdio) running');
console.error(`  Tenant: ${TENANT}`);
console.error(`  Relay:  ${CODESPACE_URL}`);
console.error(`  Tools:  ${TOOLS.length}`);
