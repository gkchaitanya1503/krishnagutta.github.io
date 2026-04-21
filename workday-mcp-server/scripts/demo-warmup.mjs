#!/usr/bin/env node
/**
 * Demo Warmup Script
 *
 * Verifies the Codespace server is up and shows pre-demo checklist.
 * Configure the target URL via environment variable or CLI arg:
 *
 *   CODESPACE_URL=https://my-codespace-4000.app.github.dev npm run demo-warmup
 *   npm run demo-warmup -- https://my-codespace-4000.app.github.dev
 */

const BASE = (process.argv[2] || process.env.CODESPACE_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'change-this-to-a-secret';

const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

function ok(msg)   { console.log(`  ${GREEN}✅${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}⚠️  ${RESET}${msg}`); }
function fail(msg) { console.log(`  ${RED}❌${RESET} ${msg}`); }
function line()    { console.log('  ' + '─'.repeat(54)); }

async function main() {
  console.log(`\n${BOLD}  Workday MCP — Warmup Check${RESET}`);
  console.log(`  ${new Date().toLocaleString()}\n`);

  if (!BASE) {
    fail('No target URL provided.');
    console.log(`\n  Usage:`);
    console.log(`    CODESPACE_URL=https://my-codespace-4000.app.github.dev npm run demo-warmup`);
    console.log(`    npm run demo-warmup -- https://my-codespace-4000.app.github.dev\n`);
    process.exit(1);
  }

  // ── 1. Health check ───────────────────────────────────────
  let health;
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10_000) });
    health = r.ok ? await r.json() : null;
  } catch (_) {}

  if (!health) {
    fail(`Server not responding at ${BASE}`);
    console.log(`\n  To restart the Codespace server, open it and run:\n  ${BOLD}npm run reload${RESET}\n`);
    process.exit(1);
  }
  ok(`Server is UP`);
  console.log(`     URL:    ${BASE}`);
  console.log(`     Setup:  ${BASE}/setup`);
  console.log(`     Admin:  ${BASE}/admin?key=${ADMIN_KEY}`);
  line();

  // ── 2. Parse admin page for session info ──────────────────
  let sessionCount = 0;
  let sessionNames = [];
  try {
    const r = await fetch(`${BASE}/admin?key=${ADMIN_KEY}`, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const html = await r.text();
      const m = html.match(/Active Sessions[^<]*<span[^>]*>(\d+)<\/span>/);
      sessionCount = m ? parseInt(m[1]) : 0;
      const nameMatches = [...html.matchAll(/<td>([A-Z][a-z]+ [A-Z][a-z]+)<\/td>/g)];
      sessionNames = [...new Set(nameMatches.map(m => m[1]))].slice(0, 10);
    }
  } catch (_) {}

  if (sessionCount > 0) {
    ok(`${sessionCount} active MCP session(s)`);
    if (sessionNames.length) {
      console.log(`     Users: ${sessionNames.join(', ')}`);
    }
  } else {
    warn(`No active MCP sessions right now`);
    console.log(`     (Normal if no Claude Desktop clients are connected yet)`);
  }
  line();

  // ── 3. Pre-demo checklist ──────────────────────────────────
  console.log(`\n${BOLD}  Pre-Demo Checklist${RESET}\n`);
  console.log(`  ${YELLOW}[  ]${RESET} All demo participants have authenticated via /setup`);
  console.log(`  ${YELLOW}[  ]${RESET} Claude Desktop config pasted + restarted on each laptop`);
  console.log(`  ${YELLOW}[  ]${RESET} GitHub Actions keep-alive workflow is ENABLED`);
  console.log(`  ${YELLOW}[  ]${RESET} Codespace inactivity timeout extended to 240 min`);
  console.log(`       → github.com/settings/codespaces`);
  console.log(`  ${YELLOW}[  ]${RESET} Admin dashboard open in a browser tab during demo`);
  console.log(`       → ${BASE}/admin?key=${ADMIN_KEY}`);
  console.log(`  ${YELLOW}[  ]${RESET} Test a tool call: ask Claude "Show me my Workday profile"\n`);

  console.log(`  Share setup link with demo participants:`);
  console.log(`  ${BOLD}${BASE}/setup${RESET}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
