# QBitmap Backend Server

ESP32-CAM streaming backend for QBitmap map application.

## Architecture

- **Framework**: Fastify (high-performance Node.js web framework)
- **Database**: SQLite with better-sqlite3 (synchronous, fast)
- **Authentication**: HMAC-SHA256 device tokens
- **Deployment**: systemd service + Caddy reverse proxy with auto-HTTPS

## API Endpoints

### Health Check
```bash
GET https://stream.qbitmap.com/health
```

### Device Registration
```bash
POST https://stream.qbitmap.com/api/devices
Headers:
  X-Device-ID: {device_id}
  X-Device-Token: {hmac_sha256(device_id, "chihuahua7")}

Response:
{
  "status": "registered",
  "camera_id": 1,
  "device_id": "0c9ad0f1ec44",
  "message": "Device registered successfully"
}
```

### Frame Upload (with Settings Sync)
```bash
POST https://stream.qbitmap.com/api/devices/{device_id}/frame
Headers:
  X-Device-ID: {device_id}
  X-Device-Token: {hmac_token}
  X-Config-Version: {current_version}
  Content-Type: image/jpeg
Body: JPEG binary data

Response (settings update needed):
{
  "status": "ok",
  "frame_id": 123,
  "settings": {
    "resolution": "UXGA",
    "quality": 12,
    "fps": 1.0
  },
  "config_version": 2
}

Response (no settings update):
{
  "status": "ok",
  "frame_id": 124
}
```

### Get Camera Info
```bash
GET https://stream.qbitmap.com/api/devices/{device_id}
Headers:
  X-Device-ID: {device_id}
  X-Device-Token: {hmac_token}

Response:
{
  "camera": {
    "id": 1,
    "device_id": "0c9ad0f1ec44",
    "name": "My Camera",
    "location": null,
    "is_public": false,
    "stream_mode": "snapshot",
    "last_seen": "2025-11-24 08:10:43",
    "created_at": "2025-11-24 08:10:43"
  },
  "settings": {
    "config_version": 1,
    "settings": {...},
    "updated_at": "2025-11-24 08:32:20"
  },
  "frame_count": 150
}
```

## Settings Sync - "Piggyback" Method

Settings are synced via frame upload responses to eliminate polling overhead:

1. ESP32 uploads frame with `X-Config-Version: 5`
2. Backend checks if newer settings exist
3. If yes: Response includes settings + `X-Config-Version: 7` header
4. If no: Response is minimal with just frame_id

This reduces HTTP requests by ~50% compared to separate polling.

## Database Schema

### Tables
- **users**: Google OAuth user accounts
- **cameras**: Device registry with location, visibility, stream mode
- **camera_settings**: JSON settings with versioning
- **frames**: JPEG frames (last 1500 per camera)

### Cleanup Job
Runs every 6 hours via node-cron to keep last 1500 frames per camera.

## Service Management

### Start/Stop/Restart
```bash
systemctl start qbitmap-backend
systemctl stop qbitmap-backend
systemctl restart qbitmap-backend
```

### View Logs
```bash
journalctl -u qbitmap-backend -f
```

### Check Status
```bash
systemctl status qbitmap-backend
```

## File Structure

```
/opt/qbitmap-backend/
├── index.js                    # Entry point
├── package.json
├── qbitmap.db                  # SQLite database
├── src/
│   ├── config.js              # Configuration
│   ├── server.js              # Fastify server setup
│   ├── routes/
│   │   └── devices.js         # Device API endpoints
│   ├── services/
│   │   ├── database.js        # SQLite operations
│   │   └── cleanup.js         # Frame cleanup cron
│   └── utils/
│       └── auth.js            # HMAC validation
```

## Development

### Install Dependencies
```bash
npm install
```

### Run in Development Mode (with watch)
```bash
npm run dev
```

### Run in Production Mode
```bash
npm start
```

## Testing

### Generate Device Token
```bash
node test-device.js
```

### Test Registration
```bash
curl -X POST https://stream.qbitmap.com/api/devices \
  -H "X-Device-ID: 0c9ad0f1ec44" \
  -H "X-Device-Token: 807a799728ce2548245bf54a91204e59bc7085798bd49d5cedfa26e2603b1c7d"
```

### Test Frame Upload
```bash
curl -X POST https://stream.qbitmap.com/api/devices/0c9ad0f1ec44/frame \
  -H "X-Device-ID: 0c9ad0f1ec44" \
  -H "X-Device-Token: 807a799728ce2548245bf54a91204e59bc7085798bd49d5cedfa26e2603b1c7d" \
  -H "X-Config-Version: 0" \
  -H "Content-Type: image/jpeg" \
  --data-binary "@/path/to/test.jpg"
```

## Performance

- **Request throughput**: ~76,000 req/sec (Fastify)
- **Frame storage**: Last 1500 frames per camera
- **Cleanup frequency**: Every 6 hours
- **Settings sync overhead**: Zero (piggyback method)

## Next Steps

1. ✅ Backend API with device endpoints
2. ✅ Settings sync via frame upload
3. ✅ Frame cleanup cron job
4. ✅ systemd service
5. ✅ Caddy reverse proxy with HTTPS
6. 🔲 Google OAuth integration
7. 🔲 Frontend camera management UI
8. 🔲 ESP32 firmware updates

## Notes

- Shared secret for HMAC: `chihuahua7` (must match firmware)
- Default port: 3000 (proxied via Caddy)
- Database location: `/opt/qbitmap-backend/qbitmap.db`
- Service name: `qbitmap-backend.service`
