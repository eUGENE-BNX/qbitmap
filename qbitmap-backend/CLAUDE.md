# QBitmap Backend - Critical Information

## DEPLOYMENT PATH (CRITICAL!)

**Server path: `/opt/qbitmap-backend`**
**NEVER use `/var/www/` - this is WRONG!**

## Deployment (MANDATORY: use deploy.sh)

**ALWAYS use `./deploy.sh` - NEVER run raw rsync commands.**
The script has hardcoded excludes for `uploads/` and `*.pem` keys, runs a
dry-run first, and prompts before pushing.

```bash
cd /home/eugene/Documents/CODES/Qbitmap/qbitmap-backend
./deploy.sh
```

## Database
- **MySQL 8** via `mysql2/promise` pool (see `src/services/db-pool.js`)
- Connection config from env (`DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`,
  `DB_PORT=3306`) loaded via `/etc/qbitmap/secrets.env` (systemd EnvironmentFile)
- SQLite was retired; any `*.db` / `*.db-wal` / `*.db-shm` file on disk is a
  stale fragment from the old stack and can be removed safely.
- Schema changes go through `migrations/` (startup-applied by `db.ensureReady`).

## Service
- Systemd: `qbitmap-backend.service`
- Runs as user: `qbitmap`
- Port: `3000`

## API Endpoints
- Public: `/api/cameras`, `/api/onvif/*`
- Auth: `/auth/*`
- Protected: require HttpOnly cookie auth

## Voice Call Integration
- Matrix API: `http://91.98.131.74:8000`
- `sample_type` must be lowercase: `fire`, `human`, `person`
- 30 second cooldown per device
