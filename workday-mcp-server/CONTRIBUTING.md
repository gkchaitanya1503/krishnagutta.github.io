# Contributing

Thanks for your interest in contributing! This is a proof-of-concept Workday MCP server — contributions that make it more useful, more secure, or more generic are very welcome.

## Ground rules

- **This is a POC.** We keep the surface area small on purpose. Before adding a tool or feature, ask: *does this belong in a generic, tenant-agnostic Workday MCP server?* Tenant-specific, customer-specific, or job-ladder-specific logic should live in a fork.
- **Security first.** This codebase handles OAuth tokens. Any PR that touches auth, session storage, or redirect handling will get extra scrutiny. If in doubt, open an issue to discuss *before* writing code.
- **No secrets in commits.** Never commit `.env`, tokens, client secrets, or real tenant IDs. The `.gitignore` is your friend.

## Ways to contribute

- **Bug reports.** Use [issue templates](./.github/ISSUE_TEMPLATE/). Include reproduction steps, env (Node version, OS, Claude Desktop version), and a redacted log.
- **Feature requests.** Open an issue first so we can agree on scope before you build.
- **New tools.** See [Adding a new tool](#adding-a-new-tool).
- **Docs.** Typo fixes, clarifications, better examples — always welcome.
- **Security issues.** Do **not** open a public issue. See [SECURITY.md](./SECURITY.md).

## Development workflow

1. Fork the repo, create a feature branch: `git checkout -b my-feature`
2. Make changes, make sure they pass: `npm run lint`
3. Test locally against a Workday implementation tenant if your change touches API calls.
4. Commit with a clear message (see [Commit style](#commit-style))
5. Push and open a PR against `main`
6. Fill out the [PR template](./.github/PULL_REQUEST_TEMPLATE.md)
7. A maintainer reviews and merges

## Commit style

Short, imperative, present-tense summaries. No prefix tags required but welcome.

Good:
- `Fix race in token refresh when two tools call simultaneously`
- `Add get_my_emergency_contacts tool`
- `Document WORKDAY_AUTH_URL gotcha in README`

Avoid:
- `updates` / `fixes` / `wip`
- Multi-line walls of text in the summary

## Adding a new tool

Tools live in `mcp-server.mjs`. Pattern:

```javascript
server.tool(
  'get_my_emergency_contacts',                              // snake_case name
  'Get the authenticated user\'s emergency contacts.',      // description (be specific — Claude uses this to decide when to call)
  {
    // zod schema for args (empty object for no args)
    includeInactive: z.boolean().optional().describe('Include inactive contacts'),
  },
  async ({ includeInactive }) => {
    const qs = includeInactive ? '?includeInactive=true' : '';
    return toText('Emergency Contacts', await wd(`/workers/me/emergencyContacts${qs}`));
  }
);
```

Checklist for a new tool PR:

- [ ] Uses the `wd()` or `wdPost()` helper (don't call `fetch`/`axios` directly — they bypass auth handling)
- [ ] Zod schema on all args with `.describe()` for each field
- [ ] Description is specific enough that Claude knows when to call it
- [ ] No hardcoded tenant or customer references
- [ ] Handles 401 gracefully (the helpers do this)
- [ ] Added to the tools table in `README.md` and `SETUP_GUIDE.md`

## Code style

- Plain JS (`.mjs`). No transpilation, no TypeScript.
- 2-space indent, single quotes, trailing commas in multiline.
- Keep functions small. If `mcp-server.mjs` or `server.mjs` cross 2000 lines, we'll split.

## Running locally

```bash
npm install
cp .env.example .env                # fill in your dev tenant
node server.mjs                     # terminal 1
node mcp-server.mjs                 # terminal 2 (or via Claude Desktop)
```

For MCP tool testing without Claude Desktop, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector node mcp-server.mjs
```

## CI

Every PR runs:
- `npm run lint` — Node syntax check on all JS files
- `npm audit --omit=dev --audit-level=high` — dependency security scan

These must pass before merge.
