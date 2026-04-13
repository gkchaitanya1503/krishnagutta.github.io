#!/usr/bin/env node
/**
 * Workday MCP Server — Codespace Relay
 *
 * Runs in a GitHub Codespace to provide an HTTPS endpoint for Workday OAuth.
 * Handles PKCE auth flow and relays tokens back to the local mcp-server.mjs.
 *
 * Usage:
 *   npm run dev        (direct)
 *   npm start          (via PM2)
 */

import 'dotenv/config';
import express from 'express';
import crypto  from 'crypto';
import axios   from 'axios';
import fs      from 'fs';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT      = process.env.PORT || 4000;
const TENANT    = process.env.WORKDAY_TENANT_ID;
const BASE_URL  = process.env.WORKDAY_BASE_URL;
const CLIENT_ID = process.env.WORKDAY_CLIENT_ID;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-to-a-secret';

if (!TENANT || !BASE_URL || !CLIENT_ID) {
  console.error('Missing required env vars: WORKDAY_TENANT_ID, WORKDAY_BASE_URL, WORKDAY_CLIENT_ID');
  process.exit(1);
}

const TOKEN_URL = process.env.WORKDAY_TOKEN_URL
  || `${BASE_URL}/ccx/oauth2/${TENANT}/token`;
const AUTH_URL  = process.env.WORKDAY_AUTH_URL
  || `${BASE_URL}/authorize`;

// Build redirect URI from Codespace env or explicit override
function getRedirectUri(req) {
  if (process.env.WORKDAY_REDIRECT_URI) return process.env.WORKDAY_REDIRECT_URI;
  const name   = process.env.CODESPACE_NAME;
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  if (name && domain) return `https://${name}-${PORT}.${domain}/callback`;
  const host = req?.headers?.host;
  if (host) return `${req.protocol}://${host}/callback`;
  return `http://localhost:${PORT}/callback`;
}

// ── Session Storage ───────────────────────────────────────────────────────────

const pkceStates    = new Map();  // state → { verifier, relayKey, redirectUri }
const relaySessions = new Map();  // relayKey → { access_token, refresh_token?, worker_name? }
const userSessions  = new Map();  // userKey → { token, name, workerId, created }
const eventLog      = [];         // { ts, type, detail }

const SESSIONS_FILE = 'sessions.json';

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data.userSessions || {})) {
        userSessions.set(k, v);
      }
      console.log(`Loaded ${userSessions.size} persisted sessions`);
    }
  } catch { /* ignore */ }
}

function saveSessions() {
  try {
    const obj = { userSessions: Object.fromEntries(userSessions) };
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch { /* ignore */ }
}

loadSessions();

function logEvent(type, detail) {
  eventLog.push({ ts: new Date().toISOString(), type, detail });
  if (eventLog.length > 500) eventLog.shift();
}

// ── PKCE Helpers ──────────────────────────────────────────────────────────────

function generatePKCE() {
  const verifier  = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ── Express App ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    sessions: userSessions.size,
    tenant: TENANT,
  });
});

// ── OAuth Login (browser redirect) ───────────────────────────────────────────

app.get('/oauth/login', (req, res) => {
  const relayKey    = req.query.relay || crypto.randomUUID();
  const redirectUri = getRedirectUri(req);
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');

  pkceStates.set(state, { verifier, relayKey, redirectUri });
  logEvent('auth_start', { relayKey, state });

  // Clean up stale states after 10 minutes
  setTimeout(() => pkceStates.delete(state), 600_000);

  const params = new URLSearchParams({
    response_type:        'code',
    client_id:            CLIENT_ID,
    redirect_uri:         redirectUri,
    scope:                req.query.scope || '',
    state,
    code_challenge:       challenge,
    code_challenge_method: 'S256',
  });

  res.redirect(`${AUTH_URL}?${params}`);
});

// ── OAuth Callback ───────────────────────────────────────────────────────────

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    logEvent('auth_error', { error, state });
    return res.status(400).send(`
      <h2>Authentication Error</h2>
      <p>${error}: ${req.query.error_description || 'Unknown error'}</p>
      <a href="/setup">Try again</a>
    `);
  }

  if (!code || !state || !pkceStates.has(state)) {
    logEvent('auth_error', { error: 'invalid_state', state });
    return res.status(400).send(`
      <h2>Invalid Request</h2>
      <p>Missing or invalid state parameter. Please start the login flow again.</p>
      <a href="/setup">Try again</a>
    `);
  }

  const pkce = pkceStates.get(state);
  pkceStates.delete(state);

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

    // Store in relay sessions for mcp-server.mjs to poll
    if (pkce.relayKey) {
      relaySessions.set(pkce.relayKey, {
        access_token,
        refresh_token,
        expires_in,
        created: Date.now(),
      });
      logEvent('auth_complete', { relayKey: pkce.relayKey });

      // Auto-expire relay session after 10 minutes (should be polled much sooner)
      setTimeout(() => relaySessions.delete(pkce.relayKey), 600_000);
    }

    // Try to fetch worker name for admin dashboard
    let workerName = 'Unknown';
    let workerId   = '';
    try {
      const profileRes = await axios.get(
        `${BASE_URL}/ccx/api/v1/${TENANT}/workers/me`,
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      const d = profileRes.data?.data?.[0] || profileRes.data;
      workerName = d?.descriptor || d?.legalName?.fullName || 'Unknown';
      workerId   = d?.id || '';
    } catch { /* non-critical */ }

    // Persist as a user session
    const userKey = crypto.randomUUID();
    userSessions.set(userKey, {
      token: access_token,
      refreshToken: refresh_token,
      name: workerName,
      workerId,
      created: new Date().toISOString(),
    });
    saveSessions();

    logEvent('session_created', { userKey, workerName });

    // Success page
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Workday MCP — Connected</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                 max-width: 600px; margin: 60px auto; padding: 0 20px; color: #333; }
          .success { background: #d4edda; border: 1px solid #c3e6cb; border-radius: 8px;
                     padding: 20px; margin: 20px 0; }
          code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-size: 14px; }
          .config-box { background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: 8px;
                        font-family: monospace; font-size: 13px; white-space: pre-wrap;
                        overflow-x: auto; position: relative; margin: 16px 0; }
          .copy-btn { position: absolute; top: 8px; right: 8px; background: #0078d4;
                      color: white; border: none; padding: 6px 12px; border-radius: 4px;
                      cursor: pointer; font-size: 12px; }
          .copy-btn:hover { background: #005a9e; }
        </style>
      </head>
      <body>
        <h1>Connected to Workday</h1>
        <div class="success">
          <strong>Welcome, ${workerName}!</strong>
          <p>Your Workday account has been linked successfully.</p>
        </div>

        <h3>If using Claude Desktop with the local MCP server:</h3>
        <p>Authentication is automatic — the token has been relayed. You can close this tab.</p>

        <h3>If using Claude Desktop with HTTP transport:</h3>
        <p>Add this to your <code>claude_desktop_config.json</code>:</p>
        <div class="config-box" id="config">
${JSON.stringify({
  mcpServers: {
    workday: {
      type: 'http',
      url: `CODESPACE_URL_PLACEHOLDER/mcp/${userKey}`,
      headers: { Authorization: `Bearer ${access_token}` },
    }
  }
}, null, 2)}
          <button class="copy-btn" onclick="copyConfig()">Copy</button>
        </div>

        <p><em>Token expires in ${Math.round((expires_in || 3600) / 60)} minutes.
        Re-authenticate at <a href="/setup">/setup</a> when it expires.</em></p>

        <script>
          // Replace placeholder with actual URL
          const el = document.getElementById('config');
          el.textContent = el.textContent.replace(
            'CODESPACE_URL_PLACEHOLDER',
            location.origin
          );
          function copyConfig() {
            navigator.clipboard.writeText(el.textContent.trim());
            document.querySelector('.copy-btn').textContent = 'Copied!';
            setTimeout(() => document.querySelector('.copy-btn').textContent = 'Copy', 2000);
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    logEvent('token_error', { error: err.message });
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    res.status(500).send(`
      <h2>Token Exchange Failed</h2>
      <pre>${detail}</pre>
      <p><a href="/setup">Try again</a></p>
    `);
  }
});

// ── Session Polling (for mcp-server.mjs relay) ───────────────────────────────

app.get('/session/:key', (req, res) => {
  const session = relaySessions.get(req.params.key);
  if (session?.access_token) {
    // One-time retrieval — delete after delivering
    relaySessions.delete(req.params.key);
    return res.json({ access_token: session.access_token });
  }
  res.status(202).json({ status: 'pending' });
});

// ── Setup Page ───────────────────────────────────────────────────────────────

app.get('/setup', (req, res) => {
  const redirectUri = getRedirectUri(req);
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Workday MCP — Setup</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
               max-width: 700px; margin: 60px auto; padding: 0 20px; color: #333; }
        .btn { display: inline-block; background: #0078d4; color: white;
               padding: 12px 24px; border-radius: 6px; text-decoration: none;
               font-size: 16px; margin: 16px 0; }
        .btn:hover { background: #005a9e; }
        .info { background: #e7f3fe; border-left: 4px solid #0078d4;
                padding: 12px 16px; margin: 16px 0; border-radius: 0 4px 4px 0; }
        code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; }
        table { border-collapse: collapse; width: 100%; margin: 16px 0; }
        th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; }
      </style>
    </head>
    <body>
      <h1>Workday MCP Server</h1>
      <p>Connect your Workday account to use with Claude Desktop.</p>

      <a href="/oauth/login" class="btn">Connect Workday Account</a>

      <div class="info">
        <strong>Tenant:</strong> ${TENANT}<br>
        <strong>Redirect URI:</strong> <code>${redirectUri}</code><br>
        <strong>Auth URL:</strong> <code>${AUTH_URL}</code>
      </div>

      <h3>Admin Checklist</h3>
      <p>Ensure the following is configured in your Workday tenant:</p>
      <table>
        <tr><th>Setting</th><th>Value</th></tr>
        <tr><td>Grant Type</td><td>Authorization Code Grant</td></tr>
        <tr><td>PKCE</td><td>Enabled (Required)</td></tr>
        <tr><td>Redirect URI</td><td><code>${redirectUri}</code></td></tr>
        <tr><td>Access Token Type</td><td>Bearer</td></tr>
        <tr><td>Scopes</td><td>Staffing, Human Resources, Absence Management, etc.</td></tr>
      </table>

      <h3>Active Sessions: ${userSessions.size}</h3>
    </body>
    </html>
  `);
});

// ── Admin Dashboard ──────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).send('Forbidden — pass ?key=YOUR_ADMIN_KEY');
  }

  const sessions = [...userSessions.entries()].map(([k, v]) => `
    <tr>
      <td>${v.name || 'Unknown'}</td>
      <td><code>${k.slice(0, 8)}...</code></td>
      <td>${v.created || 'N/A'}</td>
    </tr>
  `).join('');

  const events = eventLog.slice(-50).reverse().map(e => `
    <tr>
      <td>${e.ts}</td>
      <td><strong>${e.type}</strong></td>
      <td><code>${JSON.stringify(e.detail)}</code></td>
    </tr>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Workday MCP — Admin</title>
      <meta http-equiv="refresh" content="30">
      <style>
        body { font-family: -apple-system, sans-serif; max-width: 900px;
               margin: 40px auto; padding: 0 20px; color: #333; }
        table { border-collapse: collapse; width: 100%; margin: 12px 0; }
        th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; }
        code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
        h2 span { background: #0078d4; color: white; border-radius: 12px;
                   padding: 2px 10px; font-size: 14px; margin-left: 8px; }
      </style>
    </head>
    <body>
      <h1>Workday MCP — Admin Dashboard</h1>
      <p>Tenant: <strong>${TENANT}</strong> | Uptime: ${Math.round(process.uptime())}s
         | Pending relays: ${relaySessions.size}</p>

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
    </html>
  `);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const redirectUri = getRedirectUri();
  console.log(`Workday MCP Relay running on port ${PORT}`);
  console.log(`  Tenant:       ${TENANT}`);
  console.log(`  Auth URL:     ${AUTH_URL}`);
  console.log(`  Token URL:    ${TOKEN_URL}`);
  console.log(`  Redirect URI: ${redirectUri}`);
  console.log(`  Setup:        http://localhost:${PORT}/setup`);
  console.log(`  Admin:        http://localhost:${PORT}/admin?key=${ADMIN_KEY}`);
});
