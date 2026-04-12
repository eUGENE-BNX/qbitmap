/**
 * Standardized error response helpers.
 *
 * [ARCH-01] Every error response follows the structured envelope:
 *   { error: { code: 'NOT_FOUND', message: 'Camera not found' } }
 *
 * This matches the shape the global error handler in server.js produces
 * and the preSerialization hook enforces on legacy flat-string sends.
 *
 * Usage in route handlers:
 *   const { notFound, forbidden, badRequest } = require('../utils/error-response');
 *   return notFound(reply, 'Camera not found');
 *   return badRequest(reply, 'Invalid ID', { field: 'cameraId' });
 */

function sendError(reply, statusCode, code, message, extra) {
  const body = { error: { code, message } };
  if (extra) Object.assign(body, extra);
  return reply.code(statusCode).send(body);
}

const badRequest     = (reply, msg, extra) => sendError(reply, 400, 'BAD_REQUEST', msg, extra);
const unauthorized   = (reply, msg)        => sendError(reply, 401, 'UNAUTHORIZED', msg || 'Authentication required');
const forbidden      = (reply, msg)        => sendError(reply, 403, 'FORBIDDEN', msg || 'Not authorized');
const notFound       = (reply, msg)        => sendError(reply, 404, 'NOT_FOUND', msg || 'Not found');
const conflict       = (reply, msg, extra) => sendError(reply, 409, 'CONFLICT', msg, extra);
const gone           = (reply, msg, extra) => sendError(reply, 410, 'GONE', msg, extra);
const tooLarge       = (reply, msg)        => sendError(reply, 413, 'PAYLOAD_TOO_LARGE', msg || 'Payload too large');
const tooMany        = (reply, msg)        => sendError(reply, 429, 'RATE_LIMIT', msg || 'Too many requests');
const serverError    = (reply, msg)        => sendError(reply, 500, 'INTERNAL_ERROR', msg || 'Internal server error');
const badGateway     = (reply, msg)        => sendError(reply, 502, 'BAD_GATEWAY', msg || 'Bad gateway');
const unavailable    = (reply, msg, extra) => sendError(reply, 503, 'SERVICE_UNAVAILABLE', msg, extra);

module.exports = {
  badRequest, unauthorized, forbidden, notFound,
  conflict, gone, tooLarge, tooMany,
  serverError, badGateway, unavailable
};
