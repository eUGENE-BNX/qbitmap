const pool = require('./db-pool');
const cache = require('./cache');

async function upsertCamera(camera) {
  await pool.query(
    `INSERT INTO cameras (qbitmap_id, device_id, lat, lng, name, camera_type, is_public, h3_res14)
     VALUES ($1, $2, $3, $4, $5, $6, $7, h3_latlng_to_cell(POINT($4, $3), 14))
     ON CONFLICT (qbitmap_id)
     DO UPDATE SET
       device_id = EXCLUDED.device_id,
       lat = EXCLUDED.lat,
       lng = EXCLUDED.lng,
       name = EXCLUDED.name,
       camera_type = EXCLUDED.camera_type,
       is_public = EXCLUDED.is_public,
       h3_res14 = h3_latlng_to_cell(POINT(EXCLUDED.lng, EXCLUDED.lat), 14),
       synced_at = NOW()`,
    [camera.qbitmap_id, camera.device_id, camera.lat, camera.lng,
     camera.name, camera.camera_type || 'whep', camera.is_public || false]
  );

  await pool.query('SELECT refresh_h3_counts()');
  cache.invalidateAll();
}

async function fullSync(cameras) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const cam of cameras) {
      if (!cam.lat || !cam.lng) continue;
      await client.query(
        `INSERT INTO cameras (qbitmap_id, device_id, lat, lng, name, camera_type, is_public, h3_res14)
         VALUES ($1, $2, $3, $4, $5, $6, $7, h3_latlng_to_cell(POINT($4, $3), 14))
         ON CONFLICT (qbitmap_id)
         DO UPDATE SET
           device_id = EXCLUDED.device_id,
           lat = EXCLUDED.lat, lng = EXCLUDED.lng,
           name = EXCLUDED.name,
           camera_type = EXCLUDED.camera_type,
           is_public = EXCLUDED.is_public,
           h3_res14 = h3_latlng_to_cell(POINT(EXCLUDED.lng, EXCLUDED.lat), 14),
           synced_at = NOW()`,
        [cam.id || cam.qbitmap_id, cam.device_id, cam.lat, cam.lng,
         cam.name, cam.camera_type || 'whep', !!cam.is_public]
      );
    }

    await client.query('SELECT refresh_h3_counts()');
    await client.query('COMMIT');

    cache.invalidateAll();
    console.log(`[Sync] Full sync completed: ${cameras.length} cameras`);
    return { synced: cameras.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function removeCamera(deviceId) {
  await pool.query('DELETE FROM cameras WHERE device_id = $1', [deviceId]);
  await pool.query('SELECT refresh_h3_counts()');
  cache.invalidateAll();
}

module.exports = { upsertCamera, fullSync, removeCamera };
