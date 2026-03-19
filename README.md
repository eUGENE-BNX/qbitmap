# Qbitmap

Harita tabanlı kamera yönetim ve izleme platformu. MapLibre GL ile interaktif harita üzerinde kamera konumlarını, canlı yayınları, ONVIF eventlerini ve araç takibini yönetir.

## Servisler

| Servis | Açıklama | Port |
|--------|----------|------|
| `qbitmap` | Frontend (HTML/JS/MapLibre GL) | — |
| `qbitmap-backend` | REST API + WebSocket (Fastify + SQLite) | 3000 |
| `h3-service` | H3 Hexagonal grid API (Fastify + PostgreSQL) | 3100 |
| `onvif-events` | ONVIF kamera event listener | 3003 |
| `rtsp-capture` | RTSP frame capture | 3002 |
| `rtcgateway` | WebRTC / RTSP gateway (MediaMTX) | Docker |

## Kurulum

### Gereksinimler
- Node.js 20+
- PostgreSQL (h3-service için)
- Docker + Docker Compose (rtcgateway için)
- FFmpeg (rtsp-capture için)

### Node.js Servisleri

Her servis için:

```bash
cd <servis-klasörü>
cp .env.example .env   # .env dosyasını düzenle
npm install
npm start
```

### onvif-events Kamera Konfigürasyonu

```bash
cd onvif-events
cp cameras.example.json cameras.json   # cameras.json düzenle
```

### rtcgateway (Docker)

```bash
cd rtcgateway
docker compose up -d
```

### Frontend

`qbitmap/` klasörü static dosyalardan oluşur. Caddy veya nginx ile servis edilir:

```bash
# Caddy örneği
caddy file-server --root ./qbitmap --listen :8080
```

## Mimari

```
Browser → Caddy (qbitmap frontend)
              ↓
         qbitmap-backend (API :3000)
              ↓
    ┌─────────┼──────────────┐
    │         │              │
h3-service  onvif-events  rtsp-capture
(:3100)     (:3003)       (:3002)
                              ↓
                         rtcgateway (WebRTC/RTSP)
```

## Lisans

MIT
