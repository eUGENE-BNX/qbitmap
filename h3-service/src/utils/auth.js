const config = require('../config');

function serviceKeyHook(request, reply, done) {
  const key = request.headers['x-service-key'];
  if (!key || key !== config.serviceKey) {
    return reply.code(403).send({ error: 'Invalid service key' });
  }
  done();
}

module.exports = { serviceKeyHook };
