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

## SSH/Deployment
```bash
# Frontend - build then deploy dist/ (NOT source!)
cd qbitmap && npm run build
rsync -avz --delete --exclude='maps' --exclude='uploads' --exclude='teslacam' --exclude='3d' --exclude='model' --exclude='videos' dist/ root@91.99.219.248:/opt/qbitmap/

# Backend
rsync -avz --delete --exclude='.git' --exclude='node_modules' --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='uploads' /home/eugene/Documents/CODES/qbitmap-backend/ root@91.99.219.248:/opt/qbitmap-backend/
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
