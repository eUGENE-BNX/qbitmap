const pool = require('./db-pool');
const cache = require('./cache');

async function upsertContentItem({ itemType, itemId, userId, lat, lng, points }) {
  await pool.query(
    `INSERT INTO content_items (item_type, item_id, user_id, lat, lng, h3_res14, points)
     VALUES ($1, $2, $3, $4, $5, h3_latlng_to_cell(POINT($5, $4), 14), $6)
     ON CONFLICT (item_id)
     DO UPDATE SET
       item_type = EXCLUDED.item_type,
       user_id = EXCLUDED.user_id,
       lat = EXCLUDED.lat,
       lng = EXCLUDED.lng,
       h3_res14 = h3_latlng_to_cell(POINT(EXCLUDED.lng, EXCLUDED.lat), 14),
       points = EXCLUDED.points`,
    [itemType, itemId, userId, lat, lng, points]
  );
  cache.invalidateAll();
  // Recalculate user's video/photo counts
  await recalcUserContentCounts(userId);
}

async function removeContentItem(itemId) {
  await pool.query('DELETE FROM content_items WHERE item_id = $1', [itemId]);
  cache.invalidateAll();
}

async function upsertUserProfile({ id, displayName, avatarUrl }) {
  await pool.query(
    `INSERT INTO user_profiles (id, display_name, avatar_url, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (id)
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       avatar_url = EXCLUDED.avatar_url,
       updated_at = NOW()`,
    [id, displayName, avatarUrl]
  );
}

async function bulkUpsertContentItems(items) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const item of items) {
      if (!item.lat || !item.lng) continue;
      await client.query(
        `INSERT INTO content_items (item_type, item_id, user_id, lat, lng, h3_res14, points)
         VALUES ($1, $2, $3, $4, $5, h3_latlng_to_cell(POINT($5, $4), 14), $6)
         ON CONFLICT (item_id)
         DO UPDATE SET
           item_type = EXCLUDED.item_type,
           user_id = EXCLUDED.user_id,
           lat = EXCLUDED.lat,
           lng = EXCLUDED.lng,
           h3_res14 = h3_latlng_to_cell(POINT(EXCLUDED.lng, EXCLUDED.lat), 14),
           points = EXCLUDED.points`,
        [item.itemType, item.itemId, item.userId, item.lat, item.lng, item.points]
      );
    }

    await client.query('COMMIT');
    cache.invalidateAll();
    console.log(`[ContentSync] Bulk upsert completed: ${items.length} items`);
    return { synced: items.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function bulkUpsertUserProfiles(profiles) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const p of profiles) {
      await client.query(
        `INSERT INTO user_profiles (id, display_name, avatar_url, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (id)
         DO UPDATE SET
           display_name = EXCLUDED.display_name,
           avatar_url = EXCLUDED.avatar_url,
           updated_at = NOW()`,
        [p.id, p.displayName, p.avatarUrl]
      );
    }

    await client.query('COMMIT');
    console.log(`[ContentSync] Bulk user profiles synced: ${profiles.length}`);
    return { synced: profiles.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function recalcUserContentCounts(userId) {
  await pool.query(
    `UPDATE user_profiles SET
       video_count = COALESCE(s.vc, 0),
       photo_count = COALESCE(s.pc, 0)
     FROM (
       SELECT
         COUNT(*) FILTER (WHERE item_type = 'video') AS vc,
         COUNT(*) FILTER (WHERE item_type = 'photo') AS pc
       FROM content_items WHERE user_id = $1
     ) s
     WHERE id = $1`,
    [userId]
  );
}

async function syncItemViewCount({ itemId, viewCount }) {
  await pool.query(
    `UPDATE content_items SET view_count = $2 WHERE item_id = $1`,
    [itemId, viewCount]
  );
}

module.exports = {
  upsertContentItem,
  removeContentItem,
  upsertUserProfile,
  bulkUpsertContentItems,
  bulkUpsertUserProfiles,
  syncItemViewCount
};
