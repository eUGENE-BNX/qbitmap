# Security Policy

## Reporting a Vulnerability

If you believe you've found a security issue in QBitmap, please report it
privately. **Do not** open a public GitHub issue or post in chat — that
gives attackers the same information you have.

- **Email**: security@qbitmap.com
- Optional PGP key for sensitive details: published at https://qbitmap.com/.well-known/pgp-key.txt
- Include enough information to reproduce: affected URL/endpoint, the
  request that triggers the issue, and what you expected vs observed.

We aim to:

| Severity | Acknowledge | Initial fix or mitigation | Disclosure |
|----------|-------------|---------------------------|------------|
| Critical | 24 h | 7 days | After fix is deployed |
| High     | 72 h | 30 days | After fix is deployed |
| Medium   | 7 days | 90 days | At reporter's discretion |
| Low      | 14 days | next release | At reporter's discretion |

We don't currently run a paid bug bounty, but we are happy to publicly
credit reporters who follow this disclosure policy.

## Scope

In scope:

- `qbitmap.com` (frontend PWA)
- `stream.qbitmap.com` (backend API + WHEP signaling)
- `hls.qbitmap.com` (HLS playlist origin)
- `h3.qbitmap.com` (H3 grid / leaderboard service)
- The Fastify backend in this repository (`qbitmap-backend/`)
- The PWA frontend in this repository (`qbitmap/`)

Out of scope:

- Third-party services we use (Cloudflare, Hetzner, Tesla Fleet API,
  Google OAuth, MediaMTX, MapLibre tiles). Report those upstream.
- Social engineering or physical attacks against our team or hosting.
- Denial-of-service via volumetric flooding (we accept that's a CDN
  concern, not an application concern). We *do* care about
  application-layer DoS (e.g. unbounded resource consumption).
- Outdated TLS protocols, missing security headers on out-of-scope
  domains, and similar low-impact configuration findings.

## Defense in depth (for context)

QBitmap runs behind multiple security layers, so a single missing
control is rarely a critical compromise. In rough request order:

1. **Cloudflare** — Pro plan with managed WAF rulesets, custom rules,
   per-IP rate limits, Bot Fight Mode, and Authenticated Origin Pulls.
2. **Hetzner Cloud Firewall** — origin :443 only allows Cloudflare IP
   ranges; other ports are S1-only or fully closed.
3. **UFW + sshd** — host-level firewall, SSH key-only, password auth
   disabled, fail2ban for sshd + Caddy 4xx burst.
4. **Caddy** — Authenticated Origin Pulls (require_and_verify) so
   origin TLS handshake fails for non-Cloudflare clients.
5. **Backend (Fastify)** — Helmet, CSP, CORS allowlist, JWT with token
   versioning, Pino redaction, audit log, per-route rate limits, Zod
   validation, prepared SQL statements, file magic-byte validation.
6. **systemd hardening** — process sandbox (NoNewPrivileges,
   ProtectSystem=strict, capability drop, syscall filter).
7. **Database** — MySQL bind=127.0.0.1 with strict SQL mode, slow log;
   PostgreSQL localhost-only with pgaudit (write+ddl).
8. **Backups** — daily age-encrypted MySQL/PG dumps + weekly Hetzner
   snapshots.

If you believe you've bypassed *any* of these, that is a finding worth
reporting even if no user data was visibly exposed.
