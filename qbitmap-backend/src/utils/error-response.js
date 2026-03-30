/**
 * Standardized error response helpers.
 *
 * Usage in route handlers:
 *   const { notFound, forbidden, badRequest } = require('../utils/error-response');
 *   return notFound(reply, 'Camera not found');
 */

function sendError(reply, statusCode, message, extra) {
  const body = { error: message };
  if (extra) Object.assign(body, extra);
  return reply.code(statusCode).send(body);
}

const badRequest     = (reply, msg, extra) => sendError(reply, 400, msg, extra);
const unauthorized   = (reply, msg)        => sendError(reply, 401, msg || 'Authentication required');
const forbidden      = (reply, msg)        => sendError(reply, 403, msg || 'Not authorized');
const notFound       = (reply, msg)        => sendError(reply, 404, msg || 'Not found');
const conflict       = (reply, msg, extra) => sendError(reply, 409, msg, extra);
const gone           = (reply, msg, extra) => sendError(reply, 410, msg, extra);
const tooLarge       = (reply, msg)        => sendError(reply, 413, msg || 'Payload too large');
const tooMany        = (reply, msg)        => sendError(reply, 429, msg || 'Too many requests');
const serverError    = (reply, msg)        => sendError(reply, 500, msg || 'Internal server error');
const badGateway     = (reply, msg)        => sendError(reply, 502, msg || 'Bad gateway');
const unavailable    = (reply, msg, extra) => sendError(reply, 503, msg, extra);

module.exports = {
  badRequest, unauthorized, forbidden, notFound,
  conflict, gone, tooLarge, tooMany,
  serverError, badGateway, unavailable
};
