# QBitmap Backend - Critical Information

## DEPLOYMENT PATH (CRITICAL!)

**Server path: `/opt/qbitmap-backend`**
**NEVER use `/var/www/` - this is WRONG!**

## Deployment (MANDATORY: use deploy.sh)

**ALWAYS use `./deploy.sh` - NEVER run raw rsync commands.**
The script has hardcoded excludes for uploads/, *.pem, *.db files and runs a dry-run first.

```bash
cd /home/eugene/Documents/CODES/Qbitmap/qbitmap-backend
./deploy.sh
```

## Database
- SQLite file: `/opt/qbitmap-backend/cameras.db`
- **NEVER delete or overwrite *.db files**
- Permissions: `chmod 664` and `chown qbitmap:qbitmap`

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
