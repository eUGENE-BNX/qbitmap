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

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Mixin fires on every log write and its output is merged into the record.
  // Child loggers inherit this, so `logger.child({module}).info(...)` ends up
  // with {module, reqId} when invoked inside a request context.
  mixin() {
    const reqId = requestIdStore.getStore();
    return reqId ? { reqId } : {};
  },
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
