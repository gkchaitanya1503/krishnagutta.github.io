#!/usr/bin/env node
/**
 * Workday MCP Server — One-time setup for teammates
 *
 * Run this script to connect Claude Desktop to the Workday MCP server:
 *   node setup.js
 *
 * What it does:
 *   1. Installs dependencies (npm install)
 *   2. Asks for the Codespace URL
 *   3. Asks for Workday tenant details
 *   4. Adds workday to your Claude Desktop config
 *   5. Done — restart Claude Desktop and ask it to authenticate with Workday
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

  // 3 — Get Codespace URL
  console.log('You need the Codespace URL from your Workday MCP admin.');
  console.log('It looks like: https://NAME-4000.app.github.dev\n');

  let pocUrl = (await ask('Paste the Codespace URL: ')).trim().replace(/\/$/, '');

  if (!pocUrl.startsWith('https://')) {
    console.error('\n✗ Must be an https:// URL');
    process.exit(1);
  }

  // Quick connectivity check
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

  // 4 — Get tenant details
  console.log('');
  const tenantId = (await ask('Workday Tenant ID (e.g. "acme_corp1"): ')).trim();
  const baseUrl  = (await ask('Workday Base URL (e.g. "https://wd5-impl-services1.workday.com"): ')).trim().replace(/\/$/, '');

  if (!tenantId || !baseUrl) {
    console.error('\n✗ Tenant ID and Base URL are required');
    process.exit(1);
  }

  // 5 — Update Claude Desktop config
  const raw    = fs.readFileSync(CLAUDE_CONFIG, 'utf8');
  const config = JSON.parse(raw);
  config.mcpServers = config.mcpServers || {};

  const isUpdate = !!config.mcpServers['workday'];

  config.mcpServers['workday'] = {
    command: 'node',
    args: [SERVER_PATH],
    env: {
      WORKDAY_TENANT_ID: tenantId,
      WORKDAY_BASE_URL:  baseUrl,
      WORKDAY_POC_URL:   pocUrl,
    },
  };

  // Backup first
  fs.writeFileSync(`${CLAUDE_CONFIG}.bak`, raw);
  fs.writeFileSync(CLAUDE_CONFIG, JSON.stringify(config, null, 2));

  // 6 — Done
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✓ ${isUpdate ? 'Updated' : 'Added'} workday in Claude Desktop`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Config : ${CLAUDE_CONFIG}`);
  console.log(`  Server : ${SERVER_PATH}`);
  console.log(`  POC URL: ${pocUrl}`);
  console.log(`  Tenant : ${tenantId}`);
  console.log(`\n  Next steps:`);
  console.log(`  1. Restart Claude Desktop  (Cmd+Q / close fully → reopen)`);
  console.log(`  2. Ask Claude: "Authenticate with Workday"`);
  console.log(`  3. Sign in with your Workday credentials in the browser\n`);

  rl.close();
}

main().catch(e => {
  console.error('\n✗', e.message);
  rl.close();
  process.exit(1);
});
