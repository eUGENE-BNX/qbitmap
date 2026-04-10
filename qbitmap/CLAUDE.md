# QBitmap Project - Critical Information

## DEPLOYMENT PATHS (CRITICAL!)

**NEVER deploy to `/var/www/` - this is WRONG!**

| Component | Local Path | Server Path |
|-----------|-----------|-------------|
| Frontend  | `/home/eugene/Documents/CODES/qbitmap` | `/opt/qbitmap` |
| Backend   | `/home/eugene/Documents/CODES/qbitmap-backend` | `/opt/qbitmap-backend` |

## Web Server
- **Caddy** (NOT nginx!)
- Config: `/etc/caddy/Caddyfile`
- `qbitmap.com` → `/opt/qbitmap`
- `stream.qbitmap.com` → `localhost:3000`

## Deployment (MANDATORY: use deploy.sh scripts)

**ALWAYS use deploy.sh - NEVER run raw rsync commands.**
Scripts have hardcoded excludes and run a dry-run first with confirmation.

```bash
# Frontend
cd /home/eugene/Documents/CODES/Qbitmap/qbitmap && ./deploy.sh

# Backend
cd /home/eugene/Documents/CODES/Qbitmap/qbitmap-backend && ./deploy.sh
```

## IMPORTANT EXCLUSIONS
- **NEVER delete `maps/` folder** - contains map tiles, must be preserved
- **NEVER delete `*.db` files** - database files
- **NEVER delete `node_modules/`** - install on server separately
- **NEVER delete `uploads/` folder** - contains user uploaded face images

## File Permissions (Backend)
```bash
chown -R qbitmap:qbitmap /opt/qbitmap-backend
chmod 664 /opt/qbitmap-backend/*.db
```

## Authentication
- HttpOnly cookies (NOT localStorage)
- Always use `credentials: 'include'` in fetch requests

## Voice Call API
- URL: `http://91.98.131.74:8000`
- `sample_type` accepts only lowercase: `fire`, `human`, `person`
