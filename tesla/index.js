const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const config = require('./config');
const { handleTelemetryMessage } = require('./lib/telemetry-handler');
const logger = require('pino')({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss Z' } }
  })
});

// TLS server for Fleet Telemetry (Tesla requires TLS)
let server;

try {
  const tlsOptions = {
    cert: fs.readFileSync(config.tls.certPath),
    key: fs.readFileSync(config.tls.keyPath),
  };
  server = https.createServer(tlsOptions);
} catch (err) {
  // Fallback to HTTP for development
  logger.warn({ err: err.message }, 'TLS certs not found, falling back to HTTP (dev mode)');
  const http = require('http');
  server = http.createServer();
}

// WebSocket server for Fleet Telemetry streams
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, request) => {
  const ip = request.socket.remoteAddress;
  logger.info({ ip, url: request.url }, 'Fleet Telemetry connection opened');

  ws.on('message', async (data) => {
    try {
      await handleTelemetryMessage(data, logger);
    } catch (err) {
      logger.error({ err }, 'Error processing telemetry message');
    }
  });

  ws.on('close', () => {
    logger.info({ ip }, 'Fleet Telemetry connection closed');
  });

  ws.on('error', (err) => {
    logger.error({ err, ip }, 'Fleet Telemetry connection error');
  });
});

// Also accept HTTP POST for telemetry (alternative delivery method)
server.on('request', (req, res) => {
  if (req.method === 'POST' && req.url === '/telemetry') {
    const MAX_BODY = 1_000_000; // 1 MB hard cap

    // Reject early if Content-Length is set and over the cap.
    const declared = parseInt(req.headers['content-length'], 10);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end('{"error":"payload too large"}');
      req.destroy();
      return;
    }

    // Stream into a Buffer array; abort if streamed bytes exceed the cap
    // (covers chunked / missing Content-Length).
    const chunks = [];
    let received = 0;
    let aborted = false;

    req.on('data', chunk => {
      if (aborted) return;
      received += chunk.length;
      if (received > MAX_BODY) {
        aborted = true;
        try {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end('{"error":"payload too large"}');
        } catch (_) {}
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (aborted) return;
      try {
        await handleTelemetryMessage(Buffer.concat(chunks, received), logger);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
      } catch (err) {
        logger.error({ err }, 'Error processing HTTP telemetry');
        res.writeHead(500);
        res.end('{"error":"internal"}');
      }
    });

    req.on('error', (err) => {
      logger.warn({ err }, 'HTTP telemetry request error');
    });
  } else if (req.method === 'GET' && req.url === '/.well-known/appspecific/com.tesla.3p.public-key.pem') {
    try {
      const pubKey = fs.readFileSync('/opt/tesla/public-key.pem', 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/x-pem-file' });
      res.end(pubKey);
    } catch {
      res.writeHead(404);
      res.end();
    }
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connections: wss.clients.size }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(config.server.port, config.server.host, () => {
  logger.info({ port: config.server.port, host: config.server.host }, 'Tesla Fleet Telemetry server started');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Shutting down...');
  wss.close();
  server.close(() => process.exit(0));
});
