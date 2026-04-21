#!/usr/bin/env node
/**
 * Workday OAuth 2.0 PKCE — Standalone POC
 *
 * A single-file Node script that demonstrates the Workday OAuth 2.0
 * Authorization Code flow with PKCE. Useful for validating that:
 *   - Your Workday API client is correctly configured
 *   - Your redirect URI is registered
 *   - Token exchange succeeds
 *   - The resulting token has the expected scope
 *
 * Runs inside a GitHub Codespace so Workday sees an HTTPS redirect URI
 * (localhost is not permitted by Workday OAuth).
 *
 * Usage:
 *   cp .env.example .env    # fill in your tenant values
 *   node poc.js             # prints the authorize URL, opens browser
 *
 * Exposes:
 *   GET /                  — status + authorize link
 *   GET /callback          — handles Workday redirect, exchanges code for token
 *   GET /test              — runs a basic scope sanity check against /workers
 */

import 'dotenv/config';
import express from 'express';
import crypto  from 'crypto';
import axios   from 'axios';
import open    from 'open';

// ── Config ────────────────────────────────────────────────────────────────────

const {
  WORKDAY_BASE_URL,
  WORKDAY_TENANT_ID,
  WORKDAY_CLIENT_ID,
  WORKDAY_AUTH_URL,
  WORKDAY_TOKEN_URL,
} = process.env;

const PORT         = parseInt(process.env.PORT || '3000', 10);
const REDIRECT_URI = process.env.REDIRECT_URI
  || (process.env.CODESPACE_NAME
        ? `https://${process.env.CODESPACE_NAME}-${PORT}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/callback`
        : `http://localhost:${PORT}/callback`);

const missing = Object.entries({
  WORKDAY_BASE_URL, WORKDAY_TENANT_ID, WORKDAY_CLIENT_ID, WORKDAY_AUTH_URL, WORKDAY_TOKEN_URL,
}).filter(([_, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  console.error(`Copy .env.example to .env and fill in your tenant details.`);
  process.exit(1);
}

// ── PKCE ──────────────────────────────────────────────────────────────────────

const verifier  = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state     = crypto.randomBytes(16).toString('hex');

const authUrl = `${WORKDAY_AUTH_URL}?` + new URLSearchParams({
  response_type:         'code',
  client_id:             WORKDAY_CLIENT_ID,
  redirect_uri:          REDIRECT_URI,
  state,
  code_challenge:        challenge,
  code_challenge_method: 'S256',
});

let accessToken = null;

// ── Server ────────────────────────────────────────────────────────────────────

const app = express();

app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Workday OAuth PKCE POC</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 60px auto;
         padding: 0 20px; background: #0d1117; color: #e6edf3; }
  a.btn { display: inline-block; background: #2f81f7; color: white; padding: 10px 18px;
          border-radius: 6px; text-decoration: none; margin: 12px 0; }
  code { background: #161b22; padding: 2px 6px; border-radius: 4px; }
  .info { background: #161b22; padding: 14px 16px; border-radius: 8px; margin: 16px 0; font-size: 14px; }
  .status { padding: 10px 14px; border-radius: 6px; margin: 16px 0; }
  .status-ok  { background: #1a3d2e; color: #3fb950; }
  .status-na  { background: #3d2e1a; color: #d29922; }
</style></head>
<body>
  <h1>Workday OAuth 2.0 PKCE — POC</h1>
  <p>Test the OAuth + PKCE flow against your Workday tenant.</p>

  <div class="info">
    <strong>Tenant:</strong> ${WORKDAY_TENANT_ID}<br>
    <strong>Redirect URI:</strong> <code>${REDIRECT_URI}</code><br>
    <strong>Auth URL:</strong> <code>${WORKDAY_AUTH_URL}</code>
  </div>

  <div class="status ${accessToken ? 'status-ok' : 'status-na'}">
    ${accessToken ? '✅ Token acquired — <a href="/test">run scope test</a>' : '⚠ No token yet — click below to sign in'}
  </div>

  <a href="${authUrl}" class="btn">Sign in with Workday</a>

  <p style="color:#8b949e;font-size:.85rem;margin-top:30px">
    A browser tab will open. Sign in with your Workday credentials.
  </p>
</body></html>`);
});

app.get('/callback', async (req, res) => {
  const { code, state: returnedState, error } = req.query;

  if (error) {
    return res.status(400).send(`Auth error: ${error} — ${req.query.error_description || ''}`);
  }
  if (returnedState !== state) {
    return res.status(400).send('State mismatch — possible CSRF.');
  }

  try {
    const params = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT_URI,
      client_id:     WORKDAY_CLIENT_ID,
      code_verifier: verifier,
    });
    const r = await axios.post(WORKDAY_TOKEN_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    accessToken = r.data.access_token;

    console.log('\n═══ Token acquired ═══');
    console.log(JSON.stringify(r.data, null, 2));
    console.log('\n→ Run scope test: ' + `${REDIRECT_URI.replace('/callback', '')}/test\n`);

    res.send(`<!DOCTYPE html><html><body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px">
      <h2>✅ Token acquired</h2>
      <p><strong>expires_in:</strong> ${r.data.expires_in}s</p>
      <p><strong>token_type:</strong> ${r.data.token_type}</p>
      <p><a href="/test">Run scope test</a> · <a href="/">Home</a></p>
      <p style="color:#888">Token printed in Codespace terminal.</p>
    </body></html>`);
  } catch (e) {
    console.error('Token exchange failed:', e.response?.data || e.message);
    res.status(500).send(`<pre>${JSON.stringify(e.response?.data || e.message, null, 2)}</pre>`);
  }
});

// Basic scope sanity check: /workers/me should return 1 worker;
// /workers?limit=10 should return only the same worker if scoped correctly.
app.get('/test', async (_req, res) => {
  if (!accessToken) return res.status(401).send('No token — sign in first at /');

  const base = `${WORKDAY_BASE_URL}/ccx/api/v1/${WORKDAY_TENANT_ID}`;
  const h = { Authorization: `Bearer ${accessToken}` };

  const results = await Promise.all([
    axios.get(`${base}/workers/me`,       { headers: h }).then(r => r.data).catch(e => ({ error: e.response?.status })),
    axios.get(`${base}/workers?limit=10`, { headers: h }).then(r => r.data).catch(e => ({ error: e.response?.status })),
  ]);

  res.send(`<!DOCTYPE html><html><body style="font-family:monospace;max-width:900px;margin:40px auto;padding:0 20px">
    <h2>Scope Sanity Check</h2>
    <h3>/workers/me</h3>
    <pre>${JSON.stringify(results[0], null, 2)}</pre>
    <h3>/workers?limit=10</h3>
    <p><strong>Total returned:</strong> ${results[1]?.total ?? '(error)'} ${results[1]?.total === 1 ? '✅ scoped to self' : '⚠ broader access'}</p>
    <pre>${JSON.stringify(results[1], null, 2).slice(0, 2000)}...</pre>
  </body></html>`);
});

app.listen(PORT, () => {
  console.log(`\n═══ Workday OAuth PKCE POC ═══`);
  console.log(`Tenant      : ${WORKDAY_TENANT_ID}`);
  console.log(`Base URL    : ${WORKDAY_BASE_URL}`);
  console.log(`Auth URL    : ${WORKDAY_AUTH_URL}`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);
  console.log(`\nHome page   : ${REDIRECT_URI.replace('/callback', '/')}`);
  console.log(`Authorize   : ${authUrl}\n`);

  if (process.env.OPEN_BROWSER !== 'false') {
    open(REDIRECT_URI.replace('/callback', '/')).catch(() => {});
  }
});
