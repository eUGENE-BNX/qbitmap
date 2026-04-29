# Incident Response Runbook

When a security incident is suspected, work top-down through this
runbook. The first three sections are about *containment* — stop the
bleeding before forensics. Don't lose minutes deciding whether the
problem is "really an incident": **assume yes, contain, then
investigate.**

---

## 1. Volumetric / Layer-7 attack — site is being flooded

**Signal**: pages slow or 5xx, CF dashboard shows huge request spike,
backend `qbitmap-backend` CPU pegged, MySQL pool exhausted.

1. Cloudflare Dashboard → `qbitmap.com` → **Security → Settings**
   → **Security Level: Under Attack**. This forces every request
   through a 5-second JS interactive challenge. Real browsers pass;
   bots almost always fail.
2. If a single offending IP / ASN is visible in `Security → Events`,
   add an IP Access Rule (IP, /24, or ASN) → **Block**.
3. Watch `Security → Events` for the rate of blocks. If the attack
   subsides within 15 minutes, drop Security Level back to **High**
   and keep monitoring for an hour.
4. If origin is still hot, the attack is bypassing Cloudflare.
   Continue to section 2.

## 2. Origin under direct attack (Cloudflare bypass suspected)

**Signal**: `qbitmap-backend` traffic high but Cloudflare event
volume is low. Someone learned an origin IP and is hitting it
directly through Hetzner.

1. Hetzner Cloud Console → **Firewalls → qbitmap-prod-web**
   → temporarily restrict source on ports 80/443 from "Cloudflare
   IPs" to **your admin IP only**. The site goes down for everyone
   except you, but the origin is now unreachable.
2. Cloudflare's "Always Online" cache continues to serve stale HTML
   to most visitors during this window. Verify by browsing
   incognito.
3. Investigate via Caddy access log on S1:
   `tail -f /var/lib/caddy/logs/access.log | grep -v cf-connecting-ip`
   (entries without a CF header are direct hits).
4. Once you've identified the leaked origin (typically a DNS
   misconfiguration), rotate the IP if possible (Hetzner: detach
   floating IP and reassign), then re-open the firewall.

## 3. Suspected credential / token compromise

**Signal**: unusual admin actions in `audit_log`, login from
unfamiliar geo, support reports of session takeover.

1. Bump the JWT version envelope. On S1:
   ```sh
   ssh root@91.99.219.248
   # In /etc/qbitmap/secrets.env, increment JWT_VERSION (or rotate JWT_SECRET)
   systemctl restart qbitmap-backend
   ```
   Every token in circulation becomes invalid immediately. All users
   are forced to log in again.
2. Force password / MFA reset for the affected user(s) directly in
   MySQL if needed. Inspect `audit_log` for the suspicious actor:
   ```sql
   SELECT * FROM audit_log
    WHERE user_id = ? AND ts > NOW() - INTERVAL 7 DAY
    ORDER BY ts DESC;
   ```
3. If the JWT signing secret itself may be exposed, rotate it
   (regenerate `JWT_SECRET`) and restart the backend. This invalidates
   *every* user — only do it for confirmed key leaks.

## 4. SSH brute force or successful unauthorized SSH login

**Signal**: `lastlog` shows unfamiliar IP, fail2ban repeatedly bans
similar IPs, `journalctl -u ssh` shows successful login from
unexpected source.

1. Verify fail2ban is active: `fail2ban-client status sshd`.
2. Manually ban the suspect IP:
   `fail2ban-client set sshd banip <IP>`
3. If a successful login happened: rotate **every** SSH authorized
   key on all three servers (`~/.ssh/authorized_keys`), restart `ssh`,
   verify you can still get in from a known key.
4. Snapshot the affected host before doing anything else (Hetzner
   Console → Server → Snapshot) — that preserves the disk for
   forensic analysis if the attacker installed anything.

## 5. Database compromise / data leak suspected

1. **Don't** drop tables or "fix" data yet. Snapshot the host first
   so the on-disk state is preserved.
2. Stop write traffic: `systemctl stop qbitmap-backend` on S1.
   Reads from CF cache continue serving the static site.
3. Inspect `audit_log` for the time window of suspicion. Cross-check
   against the slow query log (`/var/log/mysql/slow.log`) and the
   pgaudit log on S3.
4. Restore from the most recent clean dump:
   ```sh
   age -d -i /root/.age/qbitmap.key /backups/mysql/qb-mysql-YYYY-MM-DD-HHMM.sql.zst.age \
     | zstdcat | mysql qbitmap_staging
   ```
   Verify row counts and known-good user records before promoting
   staging to prod.

---

## Where to look

- **Caddy access log (S1)**: `/var/lib/caddy/logs/access.log` (JSON,
  one line per request, `client_ip` is the real visitor IP).
- **Backend log**: `journalctl -u qbitmap-backend -f` (Pino JSON,
  redacted secrets).
- **Audit log (MySQL)**: `audit_log` table, app-level record of every
  auth/admin/mutating request.
- **MediaMTX log (S2)**: `journalctl -u mediamtx` or
  `docker logs mediamtx`.
- **PostgreSQL audit (S3)**: `journalctl -u postgresql` (pgaudit
  entries are tagged `AUDIT:`).
- **MySQL slow log (S1)**: `/var/log/mysql/slow.log` — anything > 1s.
- **fail2ban**: `fail2ban-client status` and per-jail status.
- **Cloudflare**: Dashboard → Security → Events. Filter by Action
  (Block / Managed Challenge / Allow), by Service (WAF / Rate Limit /
  Bot Fight), by IP/ASN.
- **Hetzner Cloud Console**: Server logs, firewall logs, snapshot
  history.

## Pre-positioned tools (already configured)

- `/root/.age/qbitmap.key` (S1, S3) — private key for decrypting
  backup dumps. Keep an offline copy in a password manager.
- `/etc/cron.d/qbitmap-backups` — daily DB dump, weekly Hetzner
  snapshot of all three servers.
- `/usr/local/bin/qbitmap-snapshot-all.sh` — manual run to take an
  ad-hoc snapshot (e.g. before a risky migration or right after an
  incident is detected).

## What to do *after* the incident

1. Write up a brief timeline (when did we notice? what blocked it?
   what didn't?).
2. If user data was likely exposed: notify affected users within 72 h
   (KVKK / GDPR style), even if the exposure was minimal.
3. Open a PR with a follow-up control that would have caught this
   sooner — a new fail2ban filter, a CF custom rule, a backend rate
   limit, an audit log alert. Don't let the lesson age out.
4. If a third-party CVE was responsible, file an issue on their
   tracker referencing your timeline once you've patched.
