# Security Policy

## ⚠️ This is a Proof of Concept

This project has **not** been formally security-reviewed and is **not recommended for production** without additional hardening. Use at your own risk.

## Supported versions

Only the latest commit on `main` is supported. Older versions receive no security fixes.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via one of:

- **GitHub Security Advisories** (preferred): [Open a new advisory](https://github.com/gkchaitanya1503/workday-oauth-poc/security/advisories/new)
- **Email:** contact the repo maintainer directly (see profile)

Include:

- A clear description of the vulnerability
- Steps to reproduce
- Affected component (`server.mjs`, `mcp-server.mjs`, `poc.js`, etc.)
- Impact assessment
- Any suggested mitigation

I'll acknowledge within 72 hours and aim to publish a fix + advisory within 30 days for confirmed issues.

## Out of scope

- **Tenant-specific misconfiguration.** If your Workday admin registers a too-permissive redirect URI or grants scopes beyond what you need, that's on the admin. This project can't enforce tenant policy.
- **Codespace port visibility.** The `/setup` and `/callback` endpoints are intentionally public. Treat the Codespace URL as world-readable.
- **Phishing via redirect URI.** Users must visit `https://<your-real-relay>/setup` directly. We can't prevent someone from setting up a look-alike relay.

## In scope

- Auth bypass (skip OAuth, obtain token without sign-in)
- PKCE implementation flaws (code-verifier leakage, state mismatch bypass, etc.)
- Session fixation or takeover
- Token leakage via logs, error pages, or the admin dashboard
- CSRF / open redirect in callback handling
- Dependency vulnerabilities in direct deps that affect runtime behaviour

## Hardening recommendations (for deployers)

If you're running this server for real users, you should additionally:

- **Change `ADMIN_KEY`** from the default
- **Review Codespace port visibility** — public is required for OAuth but exposes your setup page
- **Rotate client IDs** if compromised (they're not secret under PKCE, but a rotation resets all sessions)
- **Set refresh token timeout** in Workday to the shortest acceptable window (7–30 days)
- **Monitor the event log** for `auth_error` + `token_error` spikes
- **Add rate limiting** in front of `/oauth/login` and `/callback` (not built-in)
- **Use a real session store** (Redis/DB) instead of the in-memory `Map` + `sessions.json`
- **Consider TLS pinning** between `mcp-server.mjs` and the relay if you're paranoid

## Credits

We'll credit reporters in release notes unless you ask otherwise.
