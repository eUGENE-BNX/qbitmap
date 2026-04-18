# QBitmap Backend Server

Streaming and map backend for the QBitmap application. Handles user-owned
WHEP/RTSP/RTMP cameras, public city (HLS) cameras, face detection/alarm flow,
voice-call bridge, and video/photo messaging.

## Architecture

- **Framework**: Fastify (high-performance Node.js web framework)
- **Database**: MySQL 8 via `mysql2/promise` connection pool
- **Authentication**: Google OAuth + JWT (HttpOnly cookies) for users
- **Streaming**: MediaMTX (RTSP/RTMP/WHEP/HLS) behind Caddy
- **Deployment**: systemd service + Caddy reverse proxy with auto-HTTPS

## API Endpoints

### Health Check
```bash
GET https://stream.qbitmap.com/health
```

### Public Cameras
- `GET /api/public/cameras` — paginated public cameras (supports bbox filter)
- `GET /api/public/city-cameras` — all city (HLS) cameras

### User Cameras (JWT auth)
- `GET /api/users/me/cameras` — current user's cameras
- `POST /api/users/me/cameras/whep` — create WHEP camera
- `POST /api/users/me/cameras/rtsp` — create RTSP camera (with MediaMTX + ONVIF)
- `POST /api/users/me/cameras/rtmp` — create RTMP camera (GoPro/OBS)
- `GET /api/users/me/cameras/:cameraId` — single camera details
- `DELETE /api/users/me/cameras/:cameraId` — release camera

## Database Schema

### Tables
- **users**: Google OAuth user accounts
- **cameras**: Camera registry (WHEP/CITY/RTSP/RTMP) with location, visibility
- **camera_settings**: JSON settings (AI monitoring config for city cameras)
- **live_broadcasts**: Active user broadcasts
- **alarms**, **face_detection_log**, **camera_faces**, **ai_monitoring**
- **user_plans**, **user_usage**, **user_plan_overrides**

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
├── migrations/                 # Startup-applied MySQL schema migrations
├── src/
│   ├── config.js              # Configuration
│   ├── server.js              # Fastify server setup
│   ├── routes/                # HTTP + WS route handlers
│   ├── services/
│   │   ├── db-pool.js         # mysql2 pool (single source of truth)
│   │   ├── db/                # Per-domain SQL modules (users, cameras, …)
│   │   └── cleanup.js         # Retention + MediaMTX reconciliation
│   └── utils/
│       └── jwt.js             # JWT + authHook for user sessions
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

## Notes

- Default port: 3000 (proxied via Caddy)
- Database: MySQL 8 on `localhost:3306`, DB name `qbitmap` (per `/etc/qbitmap/secrets.env`)
- Service name: `qbitmap-backend.service`
