/**
 * Prometheus metrics for qbitmap-backend.
 *
 * Exposes:
 *   http_requests_total{method, route, status}          counter
 *   http_request_duration_seconds{method, route, status} histogram
 *   mysql_pool_connections_active                        gauge
 *   mysql_pool_connections_idle                          gauge
 *   mysql_pool_connection_queue_length                   gauge
 *   websocket_connections                                gauge
 *   websocket_authenticated_users                        gauge
 *   ai_queue_pending{queue}                              gauge  (photo, video)
 *   ai_queue_active{queue}                               gauge
 *   plus Node.js default metrics (process CPU, mem, event loop, GC).
 *
 * The route label uses Fastify's routeOptions.url (the route template, not
 * the concrete URL) so cardinality stays bounded regardless of path params.
 *
 * AI queue depth is sampled on an interval instead of inside the scrape
 * handler because getStats() round-trips to MySQL — we don't want every
 * Prometheus scrape to tax the DB. DB pool + WS gauges read in-process
 * state and are cheap enough to compute at scrape time via collect().
 */
const client = require('prom-client');
const dbPool = require('./db-pool');
const wsService = require('./websocket');
const photoAiQueue = require('./photo-ai-queue');
const videoAiQueue = require('./video-ai-queue');
const logger = require('../utils/logger').child({ module: 'metrics' });

const registry = new client.Registry();
registry.setDefaultLabels({ service: 'qbitmap-backend' });

// Node.js runtime metrics (CPU, mem, event-loop lag, GC, handles).
client.collectDefaultMetrics({ register: registry });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests by method, route template, and status code',
  labelNames: ['method', 'route', 'status'],
  registers: [registry]
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  // Buckets tuned for a typical web API: sub-ms to multi-second.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry]
});

// Web Push dispatch observability. `status` covers per-subscription outcome
// (sent / failed / expired / timeout), not per-user fan-out totals — that
// would conflate two different things. `pushSendDuration` measures a single
// sendNotification() call; caller batches in Promise.allSettled so we never
// double-count.
const pushSentTotal = new client.Counter({
  name: 'push_sent_total',
  help: 'Web Push send attempts grouped by outcome',
  labelNames: ['status'],
  registers: [registry]
});

const pushSendDuration = new client.Histogram({
  name: 'push_send_duration_seconds',
  help: 'Duration of a single sendNotification call',
  labelNames: ['result'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry]
});

new client.Gauge({
  name: 'mysql_pool_connections_active',
  help: 'Total open MySQL connections (in-use + idle)',
  registers: [registry],
  collect() {
    this.set(dbPool.pool?._allConnections?.length ?? 0);
  }
});

new client.Gauge({
  name: 'mysql_pool_connections_idle',
  help: 'Idle MySQL connections available for checkout',
  registers: [registry],
  collect() {
    this.set(dbPool.pool?._freeConnections?.length ?? 0);
  }
});

new client.Gauge({
  name: 'mysql_pool_connection_queue_length',
  help: 'Queries waiting for a free MySQL connection',
  registers: [registry],
  collect() {
    this.set(dbPool.pool?._connectionQueue?.length ?? 0);
  }
});

new client.Gauge({
  name: 'websocket_connections',
  help: 'Active WebSocket connections (authenticated + anonymous)',
  registers: [registry],
  collect() {
    this.set(wsService.wss?.clients?.size ?? 0);
  }
});

new client.Gauge({
  name: 'websocket_authenticated_users',
  help: 'Distinct authenticated user IDs with at least one live socket',
  registers: [registry],
  collect() {
    this.set(wsService.clients?.size ?? 0);
  }
});

// AI queue depth is polled; see file header. Gauges read cached values at
// scrape time, so scrapes never block on DB.
const aiQueuePending = new client.Gauge({
  name: 'ai_queue_pending',
  help: 'AI jobs waiting to be picked up',
  labelNames: ['queue'],
  registers: [registry]
});
const aiQueueActive = new client.Gauge({
  name: 'ai_queue_active',
  help: 'AI jobs currently being processed',
  labelNames: ['queue'],
  registers: [registry]
});

const AI_POLL_MS = 15_000;
let aiPollTimer = null;

async function sampleAiQueueDepth() {
  for (const [label, queue] of [['photo', photoAiQueue], ['video', videoAiQueue]]) {
    try {
      const stats = await queue.getStats();
      aiQueuePending.set({ queue: label }, stats.pending ?? 0);
      aiQueueActive.set({ queue: label }, stats.activeCount ?? 0);
    } catch (err) {
      logger.debug({ err: err.message, queue: label }, 'AI queue stats sample failed');
    }
  }
}

function startAiQueueSampler() {
  if (aiPollTimer) return;
  // Fire once immediately so the first scrape after boot isn't all zeros,
  // then on a steady cadence. Errors are swallowed inside sampleAiQueueDepth.
  sampleAiQueueDepth();
  aiPollTimer = setInterval(sampleAiQueueDepth, AI_POLL_MS);
  aiPollTimer.unref(); // don't keep event loop alive on shutdown
}

function stopAiQueueSampler() {
  if (aiPollTimer) {
    clearInterval(aiPollTimer);
    aiPollTimer = null;
  }
}

// Fastify hooks: one onRequest to stamp start, one onResponse to observe.
// Registered from server.js so the order relative to other hooks (req-id
// ALS, rate limit) is explicit.
function registerHttpHooks(fastify) {
  fastify.addHook('onRequest', async (request) => {
    request._metricsStart = process.hrtime.bigint();
  });

  fastify.addHook('onResponse', async (request, reply) => {
    if (!request._metricsStart) return;
    const durationSec = Number(process.hrtime.bigint() - request._metricsStart) / 1e9;
    // routeOptions.url is the route template ('/api/cameras/:id') — bounded
    // cardinality. For 404s there's no matched route; label as 'unknown' so
    // the time series doesn't explode with attacker-supplied paths.
    const route = request.routeOptions?.url ?? 'unknown';
    const labels = {
      method: request.method,
      route,
      status: String(reply.statusCode)
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationSec);
  });
}

module.exports = {
  registry,
  registerHttpHooks,
  startAiQueueSampler,
  stopAiQueueSampler,
  // Push observability — services/push.js imports these directly.
  pushSentTotal,
  pushSendDuration
};
