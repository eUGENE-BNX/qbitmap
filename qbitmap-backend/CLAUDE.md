# QBitmap Backend - Critical Information

## DEPLOYMENT PATH (CRITICAL!)

**Server path: `/opt/qbitmap-backend`**
**NEVER use `/var/www/` - this is WRONG!**

## Deployment Command
```bash
rsync -avz --delete --exclude='.git' --exclude='node_modules' --exclude='*.db' /home/eugene/Documents/CODES/qbitmap-backend/ root@91.99.219.248:/opt/qbitmap-backend/
```

## After Deployment
```bash
ssh root@91.99.219.248 "chown -R qbitmap:qbitmap /opt/qbitmap-backend && systemctl restart qbitmap-backend"
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
