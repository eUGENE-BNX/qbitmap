const cameraSync = require('../services/camera-sync');
const contentSync = require('../services/content-sync');
const { serviceKeyHook } = require('../utils/auth');

async function syncRoutes(fastify) {
  // All sync routes require service key
  fastify.addHook('preHandler', serviceKeyHook);

  // Full sync
  fastify.post('/cameras', async (request, reply) => {
    const { cameras } = request.body;
    if (!Array.isArray(cameras)) {
      return reply.code(400).send({ error: 'cameras must be an array' });
    }
    const result = await cameraSync.fullSync(cameras);
    return result;
  });

  // Single camera upsert (webhook)
  fastify.post('/camera', async (request) => {
    await cameraSync.upsertCamera(request.body);
    return { ok: true };
  });

  // Remove camera
  fastify.delete('/camera/:deviceId', async (request) => {
    await cameraSync.removeCamera(request.params.deviceId);
    return { ok: true };
  });

  // === Content item sync (ownership system) ===

  // Single content item upsert
  fastify.post('/content', async (request, reply) => {
    const { itemType, itemId, userId, lat, lng, points } = request.body;
    if (!itemType || !itemId || !userId || !lat || !lng || !points) {
      return reply.code(400).send({ error: 'Missing fields: itemType, itemId, userId, lat, lng, points' });
    }
    await contentSync.upsertContentItem({ itemType, itemId, userId, lat, lng, points });
    return { ok: true };
  });

  // Remove content item
  fastify.delete('/content/:itemId', async (request) => {
    await contentSync.removeContentItem(request.params.itemId);
    return { ok: true };
  });

  // Bulk content items sync (initial migration)
  fastify.post('/full-content', async (request, reply) => {
    const { items } = request.body;
    if (!Array.isArray(items)) {
      return reply.code(400).send({ error: 'items must be an array' });
    }
    const result = await contentSync.bulkUpsertContentItems(items);
    return result;
  });

  // User profile upsert
  fastify.post('/user-profile', async (request, reply) => {
    const { id, displayName, avatarUrl } = request.body;
    if (!id || !displayName) {
      return reply.code(400).send({ error: 'Missing fields: id, displayName' });
    }
    await contentSync.upsertUserProfile({ id, displayName, avatarUrl });
    return { ok: true };
  });

  // Bulk user profiles sync
  fastify.post('/user-profiles', async (request, reply) => {
    const { profiles } = request.body;
    if (!Array.isArray(profiles)) {
      return reply.code(400).send({ error: 'profiles must be an array' });
    }
    const result = await contentSync.bulkUpsertUserProfiles(profiles);
    return result;
  });

  // Sync status
  fastify.get('/status', async () => {
    const pool = require('../services/db-pool');
    const { rows: camRows } = await pool.query('SELECT COUNT(*) as count FROM cameras');
    const { rows: contentRows } = await pool.query('SELECT COUNT(*) as count FROM content_items');
    const { rows: userRows } = await pool.query('SELECT COUNT(*) as count FROM user_profiles');
    return {
      camerasInDb: parseInt(camRows[0].count),
      contentItemsInDb: parseInt(contentRows[0].count),
      userProfilesInDb: parseInt(userRows[0].count),
      status: 'ok'
    };
  });
}

module.exports = syncRoutes;
