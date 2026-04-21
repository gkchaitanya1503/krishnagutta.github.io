#!/usr/bin/env node
/**
 * Workday MCP Server — Codespace OAuth Relay
 *
 * Runs in a GitHub Codespace to provide an HTTPS endpoint for Workday's
 * OAuth 2.0 PKCE flow. Acts as a middleman between a local stdio MCP
 * client (mcp-server.mjs) and Workday's auth endpoints.
 *
 * Endpoints:
 *   GET  /health               — health check
 *   GET  /setup                — landing page with "Connect Workday" button
 *   GET  /oauth/login?relay=K  — starts PKCE flow, redirects to Workday authorize
 *   GET  /callback             — exchanges code for token, stores it
 *   GET  /session/:key         — polled by mcp-server.mjs to retrieve the token
 *   GET  /admin?key=ADMIN_KEY  — active sessions + event log
 *
 * Why a Codespace relay?
 *   Workday OAuth requires an HTTPS redirect URI. localhost is not allowed.
 *   Codespaces provide a public HTTPS URL (https://{NAME}-{PORT}.app.github.dev)
 *   that can be registered as the redirect URI in Workday's API client.
 *
 * Run with:
 *   npm run dev     (direct)
 *   npm start       (via PM2)
 */

import 'dotenv/config';
import express from 'express';
import crypto  from 'crypto';
import axios   from 'axios';
import fs      from 'fs';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT       = parseInt(process.env.PORT || '4000', 10);
const TENANT     = process.env.WORKDAY_TENANT_ID;
const BASE_URL   = process.env.WORKDAY_BASE_URL;
const CLIENT_ID  = process.env.WORKDAY_CLIENT_ID;
const ADMIN_KEY  = process.env.ADMIN_KEY || 'change-this-to-a-secret';

const TOKEN_URL = process.env.WORKDAY_TOKEN_URL
  || (BASE_URL && TENANT ? `${BASE_URL}/ccx/oauth2/${TENANT}/token` : null);

const AUTH_URL = process.env.WORKDAY_AUTH_URL
  || (BASE_URL && TENANT ? `${BASE_URL}/${TENANT}/authorize` : null);

const missing = [];
if (!TENANT)    missing.push('WORKDAY_TENANT_ID');
if (!BASE_URL)  missing.push('WORKDAY_BASE_URL');
if (!CLIENT_ID) missing.push('WORKDAY_CLIENT_ID');
if (!AUTH_URL)  missing.push('WORKDAY_AUTH_URL (or derivable from BASE_URL + TENANT_ID)');
if (!TOKEN_URL) missing.push('WORKDAY_TOKEN_URL (or derivable from BASE_URL + TENANT_ID)');
if (missing.length) {
  console.error(`[workday-mcp-server] Missing required env vars:\n  ${missing.join('\n  ')}`);
  console.error(`[workday-mcp-server] Copy .env.example to .env and fill in your tenant details.`);
  process.exit(1);
}

function buildRedirectUri(req) {
  if (process.env.REDIRECT_URI)         return process.env.REDIRECT_URI;
  if (process.env.WORKDAY_REDIRECT_URI) return process.env.WORKDAY_REDIRECT_URI;
  const name   = process.env.CODESPACE_NAME;
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  if (name && domain) return `https://${name}-${PORT}.${domain}/callback`;
  const host = req?.headers?.host;
  if (host) return `${req.protocol || 'https'}://${host}/callback`;
  return `http://localhost:${PORT}/callback`;
}

// ─── Session Storage ──────────────────────────────────────────────────────────

const pkceStates    = new Map(); // state → { verifier, relayKey, redirectUri, expiresAt }
const relaySessions = new Map(); // relayKey → { access_token, expiresAt }
const userSessions  = new Map(); // userKey → { token, name, workerId, created }
const eventLog      = [];        // [{ ts, type, detail }]

const SESSIONS_FILE = 'sessions.json';

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw.userSessions || {})) {
        userSessions.set(k, v);
      }
      console.log(`[workday-mcp-server] Loaded ${userSessions.size} persisted session(s)`);
    }
  } catch (e) {
    console.warn(`[workday-mcp-server] Could not load sessions: ${e.message}`);
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify({ userSessions: Object.fromEntries(userSessions) }, null, 2)
    );
  } catch (e) {
    console.warn(`[workday-mcp-server] Could not save sessions: ${e.message}`);
  }
}

loadSessions();

function logEvent(type, detail) {
  eventLog.push({ ts: new Date().toISOString(), type, detail });
  if (eventLog.length > 500) eventLog.shift();
}

// ─── PKCE Helpers ─────────────────────────────────────────────────────────────

function generatePKCE() {
  const verifier  = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  if (req.path !== '/health') {
    console.log(`${new Date().toISOString()}  ${req.method}  ${req.path}`);
  }
  next();
});

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:   'ok',
    uptime:   Math.round(process.uptime()),
    tenant:   TENANT,
    sessions: userSessions.size,
  });
});

// ── Setup landing page ───────────────────────────────────────────────────────

app.get('/setup', (req, res) => {
  const redirectUri = buildRedirectUri(req);
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Workday MCP Server — Setup</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           max-width: 720px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.6; }
    h1 { font-size: 28px; margin-bottom: 8px; }
    h3 { margin-top: 32px; font-size: 18px; }
    .btn { display: inline-block; background: #0a84ff; color: white;
           padding: 12px 24px; border-radius: 8px; text-decoration: none;
           font-size: 16px; font-weight: 500; margin: 16px 0; }
    .btn:hover { background: #0066cc; }
    .info { background: #f0f7ff; border-left: 4px solid #0a84ff;
            padding: 14px 18px; margin: 20px 0; border-radius: 0 8px 8px 0; font-size: 14px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
    th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #eee; }
    th { background: #fafafa; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Workday MCP Server</h1>
  <p>Connect your Workday account to use with Claude Desktop.</p>

  <a href="/oauth/login" class="btn">Connect Workday Account</a>

  <div class="info">
    <strong>Tenant:</strong> ${esc(TENANT)}<br>
    <strong>Redirect URI:</strong> <code>${esc(redirectUri)}</code><br>
    <strong>Auth URL:</strong> <code>${esc(AUTH_URL)}</code>
  </div>

  <h3>Admin checklist</h3>
  <p>In your Workday API Client settings, make sure the following is configured:</p>
  <table>
    <tr><th>Setting</th><th>Value</th></tr>
    <tr><td>Client Grant Type</td><td>Authorization Code Grant</td></tr>
    <tr><td>PKCE</td><td>Enabled (Required)</td></tr>
    <tr><td>Redirect URI</td><td><code>${esc(redirectUri)}</code></td></tr>
    <tr><td>Access Token Type</td><td>Bearer</td></tr>
    <tr><td>Scopes</td><td>Functional areas you want to expose (Staffing, HR, Absence, Compensation, Benefits, Payroll)</td></tr>
  </table>

  <h3>Active Sessions: ${userSessions.size}</h3>
</body>
</html>`);
});

// ── OAuth Login ──────────────────────────────────────────────────────────────

app.get('/oauth/login', (req, res) => {
  const relayKey    = typeof req.query.relay === 'string' ? req.query.relay : crypto.randomUUID();
  const scope       = typeof req.query.scope === 'string' ? req.query.scope : '';
  const redirectUri = buildRedirectUri(req);
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');

  pkceStates.set(state, {
    verifier,
    relayKey,
    redirectUri,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  logEvent('auth_start', { relayKey, state: state.slice(0, 8) + '…' });

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             CLIENT_ID,
    redirect_uri:          redirectUri,
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });
  if (scope) params.set('scope', scope);

  res.redirect(`${AUTH_URL}?${params}`);
});

// ── OAuth Callback ───────────────────────────────────────────────────────────

app.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    logEvent('auth_error', { error, state });
    return res.status(400).send(`
      <h2>Authentication Error</h2>
      <p><strong>${esc(error)}</strong>: ${esc(error_description || 'Unknown error')}</p>
      <p><a href="/setup">Try again</a></p>`);
  }

  if (!code || !state || !pkceStates.has(state)) {
    logEvent('auth_error', { error: 'invalid_state', state });
    return res.status(400).send(`
      <h2>Invalid Request</h2>
      <p>Missing or invalid state parameter. Please start the login flow again.</p>
      <p><a href="/setup">Try again</a></p>`);
  }

  const pkce = pkceStates.get(state);
  pkceStates.delete(state);

  if (pkce.expiresAt < Date.now()) {
    return res.status(400).send(`
      <h2>Request Expired</h2>
      <p>The login session expired. Please try again.</p>
      <p><a href="/setup">Start over</a></p>`);
  }

  try {
    const params = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  pkce.redirectUri,
      client_id:     CLIENT_ID,
      code_verifier: pkce.verifier,
    });

    const tokenRes = await axios.post(TOKEN_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in } = tokenRes.data;

    if (pkce.relayKey) {
      relaySessions.set(pkce.relayKey, {
        access_token,
        refresh_token,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      logEvent('auth_complete', { relayKey: pkce.relayKey });
    }

    let workerName = 'Unknown';
    let workerId   = '';
    try {
      const r = await axios.get(`${BASE_URL}/ccx/api/v1/${TENANT}/workers/me`, {
        headers: { Authorization: `Bearer ${access_token}` },
        timeout: 5000,
      });
      const d = r.data?.data?.[0] || r.data;
      workerName = d?.descriptor || d?.legalName?.fullName || 'Unknown';
      workerId   = d?.id || '';
    } catch { /* non-critical */ }

    const userKey = crypto.randomUUID();
    userSessions.set(userKey, {
      token:        access_token,
      refreshToken: refresh_token,
      name:         workerName,
      workerId,
      created:      new Date().toISOString(),
    });
    saveSessions();
    logEvent('session_created', { userKey: userKey.slice(0, 8) + '…', workerName });

    const expiresMin = Math.round((expires_in || 3600) / 60);

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Workday MCP — Connected</title>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           max-width: 720px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.6; }
    .success { background: #e8f5e9; border: 1px solid #4caf50; border-radius: 8px;
               padding: 20px; margin: 20px 0; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; }
    .config-box { background: #1e1e1e; color: #d4d4d4; padding: 18px; border-radius: 8px;
                  font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 13px;
                  white-space: pre-wrap; overflow-x: auto; position: relative; margin: 16px 0; }
    .copy-btn { position: absolute; top: 10px; right: 10px; background: #0a84ff;
                color: white; border: none; padding: 7px 14px; border-radius: 5px;
                cursor: pointer; font-size: 12px; font-weight: 500; }
    .copy-btn:hover { background: #0066cc; }
  </style>
</head>
<body>
  <h1>Connected to Workday</h1>
  <div class="success">
    <strong>Welcome, ${esc(workerName)}!</strong>
    <p>Your Workday account has been linked successfully.</p>
  </div>

  <h3>Using Claude Desktop in stdio mode (recommended)</h3>
  <p>Authentication is automatic — the token has been relayed to your local MCP server. You can close this tab.</p>

  <h3>Using Claude Desktop with HTTP transport</h3>
  <p>Copy this block into your <code>claude_desktop_config.json</code>:</p>
  <div class="config-box" id="config">${esc(JSON.stringify({
    mcpServers: {
      workday: {
        type: 'http',
        url: `CODESPACE_URL_PLACEHOLDER/mcp/${userKey}`,
        headers: { Authorization: `Bearer ${access_token}` },
      },
    },
  }, null, 2))}<button class="copy-btn" onclick="copyConfig()">Copy</button></div>

  <p><em>Token expires in ${expiresMin} minutes.
     Re-authenticate at <a href="/setup">/setup</a> when it expires.</em></p>

  <script>
    const el = document.getElementById('config');
    el.firstChild.textContent = el.firstChild.textContent.replace(
      'CODESPACE_URL_PLACEHOLDER', location.origin
    );
    function copyConfig() {
      navigator.clipboard.writeText(el.firstChild.textContent);
      const btn = document.querySelector('.copy-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    }
  </script>
</body>
</html>`);
  } catch (err) {
    logEvent('token_error', { error: err.message });
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).send(`
      <h2>Token Exchange Failed</h2>
      <pre>${esc(detail)}</pre>
      <p><a href="/setup">Try again</a></p>`);
  }
});

// ── Session polling ──────────────────────────────────────────────────────────

app.get('/session/:key', (req, res) => {
  const session = relaySessions.get(req.params.key);
  if (session?.access_token && session.expiresAt > Date.now()) {
    relaySessions.delete(req.params.key);
    return res.json({ access_token: session.access_token });
  }
  res.status(202).json({ status: 'pending' });
});

// ── Admin dashboard ──────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).send('Forbidden — pass ?key=YOUR_ADMIN_KEY');
  }

  const sessions = [...userSessions.entries()].map(([k, v]) => `
    <tr>
      <td>${esc(v.name || 'Unknown')}</td>
      <td><code>${esc(k.slice(0, 8))}…</code></td>
      <td>${esc(v.created || 'N/A')}</td>
    </tr>`).join('');

  const events = eventLog.slice(-50).reverse().map(e => `
    <tr>
      <td>${esc(e.ts)}</td>
      <td><strong>${esc(e.type)}</strong></td>
      <td><code>${esc(JSON.stringify(e.detail))}</code></td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Workday MCP — Admin</title>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="30">
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 1000px;
           margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
    th { background: #f8f9fa; font-weight: 600; }
    code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
    h2 span { background: #0a84ff; color: white; border-radius: 12px;
               padding: 2px 10px; font-size: 14px; margin-left: 8px; }
  </style>
</head>
<body>
  <h1>Workday MCP — Admin Dashboard</h1>
  <p>Tenant: <strong>${esc(TENANT)}</strong> |
     Uptime: ${Math.round(process.uptime())}s |
     Pending relays: ${relaySessions.size}</p>

  <h2>Active Sessions <span>${userSessions.size}</span></h2>
  <table>
    <tr><th>Name</th><th>Key</th><th>Created</th></tr>
    ${sessions || '<tr><td colspan="3">No sessions</td></tr>'}
  </table>

  <h2>Event Log (last 50)</h2>
  <table>
    <tr><th>Time</th><th>Type</th><th>Detail</th></tr>
    ${events || '<tr><td colspan="3">No events</td></tr>'}
  </table>
</body>
</html>`);
});

// ── Periodic cleanup ─────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pkceStates.entries())    if (v.expiresAt < now) pkceStates.delete(k);
  for (const [k, v] of relaySessions.entries()) if (v.expiresAt < now) relaySessions.delete(k);
}, 60_000);

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const redirectUri = buildRedirectUri();
  console.log(`[workday-mcp-server] Relay running on port ${PORT}`);
  console.log(`  Tenant:       ${TENANT}`);
  console.log(`  Auth URL:     ${AUTH_URL}`);
  console.log(`  Token URL:    ${TOKEN_URL}`);
  console.log(`  Redirect URI: ${redirectUri}`);
  console.log(`  Setup:        http://localhost:${PORT}/setup`);
  console.log(`  Admin:        http://localhost:${PORT}/admin?key=${ADMIN_KEY}`);
});
