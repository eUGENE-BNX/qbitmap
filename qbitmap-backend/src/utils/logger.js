/**
 * Structured Logger using Pino
 * - JSON format in production
 * - Pretty format in development
 *
 * Request-ID correlation: every log line emitted inside an HTTP request
 * automatically carries the request's reqId via AsyncLocalStorage + pino
 * mixin. No callsite changes required — existing `logger.child({module})`
 * calls pick up reqId transparently. Outbound fetch-timeout reads the same
 * ALS value to propagate X-Request-Id to H3 / Tesla / MediaMTX, so a single
 * id threads through the whole request fan-out.
 */
const pino = require('pino');
const { AsyncLocalStorage } = require('node:async_hooks');

const isProduction = process.env.NODE_ENV === 'production';

const requestIdStore = new AsyncLocalStorage();

function getRequestId() {
  return requestIdStore.getStore();
}

// Called from Fastify's onRequest hook. enterWith makes the value sticky
// for the rest of the async chain (subsequent hooks, handler, awaited fetches)
// without needing to wrap everything in a callback.
function enterRequestId(reqId) {
  requestIdStore.enterWith(reqId);
}

// Shared redact rules — applied to both this logger and the Fastify
// request logger in server.js. Anything carrying credentials, session
// tokens or password material is replaced with [REDACTED] before pino
// serializes the record. Nested wildcards catch the same fields under
// arbitrary keys (e.g. err.cause.token, body.user.password).
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'body.password',
  'body.token',
  'body.refreshToken',
  'body.access_token',
  'body.refresh_token',
  'body.client_secret',
  '*.password',
  '*.token',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
  '*.client_secret',
  '*.authorization',
];
const REDACT_CENSOR = '[REDACTED]';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Mixin fires on every log write and its output is merged into the record.
  // Child loggers inherit this, so `logger.child({module}).info(...)` ends up
  // with {module, reqId} when invoked inside a request context.
  mixin() {
    const reqId = requestIdStore.getStore();
    return reqId ? { reqId } : {};
  },
  redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
  ...(isProduction
    ? {
        formatters: {
          level: (label) => ({ level: label })
        }
      }
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname'
          }
        }
      }
  )
});

logger.child = logger.child.bind(logger);
logger.getRequestId = getRequestId;
logger.enterRequestId = enterRequestId;

module.exports = logger;
module.exports.REDACT_PATHS = REDACT_PATHS;
module.exports.REDACT_CENSOR = REDACT_CENSOR;
