#!/usr/bin/env node
/**
 * Workday MCP Server — One-time setup for end users
 *
 * Connects Claude Desktop to a running Workday MCP relay:
 *   node setup.js
 *
 * What it does:
 *   1. Installs dependencies (npm install)
 *   2. Asks for the Codespace relay URL (from your admin)
 *   3. Asks for your Workday tenant details (from your admin)
 *   4. Adds "workday" to your Claude Desktop config
 *   5. Done — restart Claude Desktop and call authenticate_workday
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const rl   = require('readline').createInterface({ input: process.stdin, output: process.stdout });

const ask = (q) => new Promise(res => rl.question(q, res));

// ─── Paths ────────────────────────────────────────────────────────────────────

const SERVER_PATH = path.resolve(__dirname, 'mcp-server.mjs');

const CLAUDE_CONFIG = (() => {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
})();

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Workday MCP Server — Setup');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 1 — Install deps if needed
  if (!fs.existsSync(path.join(__dirname, 'node_modules', '@modelcontextprotocol'))) {
    console.log('→ Installing dependencies...');
    execSync('npm install', { stdio: 'inherit', cwd: __dirname });
    console.log('  ✓ Done\n');
  }

  // 2 — Verify Claude Desktop config exists
  if (!fs.existsSync(CLAUDE_CONFIG)) {
    console.error(`✗ Claude Desktop config not found at:\n  ${CLAUDE_CONFIG}\n`);
    console.error('  Make sure Claude Desktop is installed and opened at least once.');
    process.exit(1);
  }

  // 3 — Collect config (ask admin for these)
  console.log('Ask your Workday admin for the following values:\n');

  let pocUrl = (await ask('Codespace relay URL (e.g. https://my-codespace-4000.app.github.dev): ')).trim().replace(/\/$/, '');
  if (!pocUrl.startsWith('https://')) {
    console.error('\n✗ Must be an https:// URL');
    process.exit(1);
  }

  const tenantId = (await ask('Workday Tenant ID (e.g. acme_corp1): ')).trim();
  if (!tenantId) {
    console.error('\n✗ Tenant ID required');
    process.exit(1);
  }

  const defaultBase = 'https://wd5-impl-services1.workday.com';
  const baseInput = (await ask(`Workday Base URL [${defaultBase}]: `)).trim();
  const baseUrl = baseInput || defaultBase;

  // 4 — Connectivity check
  process.stdout.write('\n→ Checking connection to Codespace... ');
  try {
    const https = require('https');
    await new Promise((resolve, reject) => {
      https.get(`${pocUrl}/health`, r => {
        r.resume();
        r.statusCode < 500 ? resolve() : reject(new Error(`HTTP ${r.statusCode}`));
      }).on('error', reject).setTimeout(5000, () => reject(new Error('timeout')));
    });
    console.log('✓ reachable');
  } catch (e) {
    console.log(`⚠ could not reach (${e.message})`);
    const cont = (await ask('  Continue anyway? [y/N]: ')).toLowerCase();
    if (cont !== 'y') { rl.close(); process.exit(0); }
  }

  // 5 — Update Claude Desktop config
  const raw    = fs.readFileSync(CLAUDE_CONFIG, 'utf8');
  const config = JSON.parse(raw);
  config.mcpServers = config.mcpServers || {};

  const existing = config.mcpServers['workday'];
  const isUpdate = !!existing;

  config.mcpServers['workday'] = {
    command: 'node',
    args: [SERVER_PATH],
    env: {
      WORKDAY_TENANT_ID: tenantId,
      WORKDAY_BASE_URL:  baseUrl,
      WORKDAY_POC_URL:   pocUrl,
    },
  };

  fs.writeFileSync(`${CLAUDE_CONFIG}.bak`, raw);
  fs.writeFileSync(CLAUDE_CONFIG, JSON.stringify(config, null, 2));

  // 6 — Done
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✓ ${isUpdate ? 'Updated' : 'Added'} "workday" in Claude Desktop`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Config  : ${CLAUDE_CONFIG}`);
  console.log(`  Backup  : ${CLAUDE_CONFIG}.bak`);
  console.log(`  Server  : ${SERVER_PATH}`);
  console.log(`  Tenant  : ${tenantId}`);
  console.log(`  Base URL: ${baseUrl}`);
  console.log(`  POC URL : ${pocUrl}`);
  console.log(`\n  Next steps:`);
  console.log(`  1. Restart Claude Desktop  (Cmd+Q → reopen)`);
  console.log(`  2. Ask Claude: "Authenticate with Workday"`);
  console.log(`  3. Sign in with your Workday credentials in the browser\n`);

  rl.close();
}

main().catch(e => {
  console.error('\n✗', e.message);
  rl.close();
  process.exit(1);
});
