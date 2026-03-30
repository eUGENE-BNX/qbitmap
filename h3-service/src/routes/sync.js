const cameraSync = require('../services/camera-sync');
const contentSync = require('../services/content-sync');
const { serviceKeyHook } = require('../utils/auth');

async function syncRoutes(fastify) {
  // All sync routes require service key
  fastify.addHook('preHandler', serviceKeyHook);

  // Full sync
  fastify.post('/cameras', {
    schema: {
      body: {
        type: 'object',
        required: ['cameras'],
        properties: { cameras: { type: 'array', maxItems: 10000 } }
      }
    }
  }, async (request) => {
    return cameraSync.fullSync(request.body.cameras);
  });

  // Single camera upsert (webhook)
  fastify.post('/camera', {
    schema: {
      body: {
        type: 'object',
        required: ['device_id'],
        properties: {
          device_id: { type: 'string', minLength: 1, maxLength: 100 },
          lat: { type: 'number' },
          lng: { type: 'number' }
        }
      }
    }
  }, async (request) => {
    await cameraSync.upsertCamera(request.body);
    return { ok: true };
  });

  // Remove camera
  fastify.delete('/camera/:deviceId', {
    schema: {
      params: {
        type: 'object',
        properties: { deviceId: { type: 'string', minLength: 1, maxLength: 100 } }
      }
    }
  }, async (request) => {
    await cameraSync.removeCamera(request.params.deviceId);
    return { ok: true };
  });

  // === Content item sync (ownership system) ===

  // Single content item upsert
  fastify.post('/content', {
    schema: {
      body: {
        type: 'object',
        required: ['itemType', 'itemId', 'userId', 'lat', 'lng', 'points'],
        properties: {
          itemType: { type: 'string', minLength: 1, maxLength: 50 },
          itemId: { type: ['string', 'integer'] },
          userId: { type: 'integer', minimum: 1 },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
          points: { type: 'number', minimum: 0 }
        }
      }
    }
  }, async (request) => {
    await contentSync.upsertContentItem(request.body);
    return { ok: true };
  });

  // Remove content item
  fastify.delete('/content/:itemId', async (request) => {
    await contentSync.removeContentItem(request.params.itemId);
    return { ok: true };
  });

  // Bulk content items sync (initial migration)
  fastify.post('/full-content', {
    schema: {
      body: {
        type: 'object',
        required: ['items'],
        properties: { items: { type: 'array', maxItems: 50000 } }
      }
    }
  }, async (request) => {
    return contentSync.bulkUpsertContentItems(request.body.items);
  });

  // User profile upsert
  fastify.post('/user-profile', {
    schema: {
      body: {
        type: 'object',
        required: ['id', 'displayName'],
        properties: {
          id: { type: 'integer', minimum: 1 },
          displayName: { type: 'string', minLength: 1, maxLength: 200 },
          avatarUrl: { type: 'string', maxLength: 500 }
        }
      }
    }
  }, async (request) => {
    await contentSync.upsertUserProfile(request.body);
    return { ok: true };
  });

  // Bulk user profiles sync
  fastify.post('/user-profiles', {
    schema: {
      body: {
        type: 'object',
        required: ['profiles'],
        properties: { profiles: { type: 'array', maxItems: 10000 } }
      }
    }
  }, async (request) => {
    return contentSync.bulkUpsertUserProfiles(request.body.profiles);
  });

  // Item view count sync
  fastify.post('/item-views', {
    schema: {
      body: {
        type: 'object',
        required: ['itemId', 'viewCount'],
        properties: {
          itemId: { type: ['string', 'integer'] },
          viewCount: { type: 'integer', minimum: 0 }
        }
      }
    }
  }, async (request) => {
    await contentSync.syncItemViewCount(request.body);
    return { ok: true };
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
