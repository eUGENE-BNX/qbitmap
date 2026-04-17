/**
 * Shared HTTP keep-alive dispatcher for every outbound fetch in the
 * process.
 *
 * Node 20's global `fetch` uses undici under the hood but defaults to a
 * dispatcher that does NOT pool connections aggressively — each request to
 * the same host pays TCP handshake + TLS startup, and under high QPS
 * against MediaMTX / H3 / AI services we'd see TIME_WAIT sockets pile up
 * on the local side. Wiring up a shared Agent and installing it as the
 * global dispatcher makes every `fetch()` call in the process reuse
 * connections per origin without any callsite change.
 *
 * `keepAliveTimeout` is how long an idle socket sticks around; 30s gives
 * AI queue polls / periodic MediaMTX syncs plenty of overlap so they
 * amortize the handshake. `connections` caps pool size per origin so a
 * burst (e.g. MediaMTX reconciliation) doesn't open an unbounded number
 * of sockets against one upstream.
 */
const { Agent, setGlobalDispatcher } = require('undici');
const logger = require('./logger').child({ module: 'http-agent' });

const agent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 10
});

setGlobalDispatcher(agent);

logger.info({ keepAliveTimeout: 30_000, connections: 10 }, 'Shared undici dispatcher installed as global');

module.exports = { agent };
