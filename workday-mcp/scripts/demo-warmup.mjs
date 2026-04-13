#!/usr/bin/env node
/**
 * Demo Warmup Script
 * Run before a demo to verify the Codespace server is up and sessions are ready.
 *
 * Usage: npm run demo-warmup
 *
 * Set CODESPACE_URL env var or pass as argument:
 *   CODESPACE_URL=https://your-codespace-4000.app.github.dev npm run demo-warmup
 */

const BASE      = process.env.CODESPACE_URL || process.argv[2] || '';
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'change-this-to-a-secret';

if (!BASE) {
  console.error('Usage: CODESPACE_URL=https://... npm run demo-warmup');
  console.error('   or: node scripts/demo-warmup.mjs https://your-codespace-4000.app.github.dev');
  process.exit(1);
}

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
  console.log(`\n${BOLD}  Workday MCP — Demo Warmup Check${RESET}`);
  console.log(`  ${new Date().toLocaleString()}\n`);

  // 1. Health check
  let health;
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10_000) });
    health = r.ok ? await r.json() : null;
  } catch { /* ignore */ }

  if (!health) {
    fail(`Server not responding at ${BASE}`);
    console.log(`\n  To restart the Codespace server, open it and run:\n  ${BOLD}npm run reload${RESET}\n`);
    process.exit(1);
  }
  ok(`Server is UP (tenant: ${health.tenant || 'unknown'})`);
  console.log(`     URL:    ${BASE}`);
  console.log(`     Setup:  ${BASE}/setup`);
  console.log(`     Admin:  ${BASE}/admin?key=${ADMIN_KEY}`);
  line();

  // 2. Session info from admin page
  let sessionCount = 0;
  try {
    const r = await fetch(`${BASE}/admin?key=${ADMIN_KEY}`, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const html = await r.text();
      const m = html.match(/Active Sessions[^<]*<span[^>]*>(\d+)<\/span>/);
      sessionCount = m ? parseInt(m[1]) : 0;
    }
  } catch { /* ignore */ }

  if (sessionCount > 0) {
    ok(`${sessionCount} active session(s)`);
  } else {
    warn(`No active sessions yet`);
    console.log(`     (Normal if no one has authenticated yet)`);
  }
  line();

  // 3. Pre-demo checklist
  console.log(`\n${BOLD}  Pre-Demo Checklist${RESET}\n`);
  console.log(`  ${YELLOW}[  ]${RESET} All participants have authenticated via /setup`);
  console.log(`  ${YELLOW}[  ]${RESET} Claude Desktop config pasted + restarted on each machine`);
  console.log(`  ${YELLOW}[  ]${RESET} GitHub Actions keep-alive workflow is ENABLED`);
  console.log(`  ${YELLOW}[  ]${RESET} Codespace inactivity timeout set to 240 min`);
  console.log(`       → github.com/settings/codespaces`);
  console.log(`  ${YELLOW}[  ]${RESET} Admin dashboard open during demo`);
  console.log(`       → ${BASE}/admin?key=${ADMIN_KEY}`);
  console.log(`  ${YELLOW}[  ]${RESET} Test: ask Claude "What is my Workday profile?"\n`);

  console.log(`  Share this setup link with participants:`);
  console.log(`  ${BOLD}${BASE}/setup${RESET}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
