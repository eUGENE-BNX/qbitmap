const pool = require('./db-pool');
const cache = require('./cache');
const { zoomToResolution } = require('./h3-service');

async function getViewportOwnership(swLat, swLng, neLat, neLng, zoom) {
  const resolution = zoomToResolution(zoom);

  const cacheKey = `own:${resolution}:${swLat.toFixed(3)}:${swLng.toFixed(3)}:${neLat.toFixed(3)}:${neLng.toFixed(3)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (cell)
       cell, user_id, display_name, avatar_url, total_points
     FROM (
       SELECT
         h3_cell_to_parent(ci.h3_res14, $1) AS cell,
         ci.user_id,
         up.display_name,
         up.avatar_url,
         SUM(ci.points) AS total_points,
         MIN(ci.created_at) AS earliest
       FROM content_items ci
       JOIN user_profiles up ON up.id = ci.user_id
       WHERE ci.lat BETWEEN $2 AND $3
         AND ci.lng BETWEEN $4 AND $5
       GROUP BY h3_cell_to_parent(ci.h3_res14, $1), ci.user_id, up.display_name, up.avatar_url
     ) sub
     ORDER BY cell, total_points DESC, earliest ASC`,
    [resolution, swLat, neLat, swLng, neLng]
  );

  const cells = rows.map(r => ({
    h3Index: r.cell,
    userId: r.user_id,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    points: parseInt(r.total_points)
  }));

  const result = { resolution, cells };
  cache.set(cacheKey, result, 30000);
  return result;
}

async function getLeaderboard(limit = 10) {
  const cacheKey = `lb:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { rows } = await pool.query(
    `SELECT
       up.id AS user_id,
       up.display_name,
       up.avatar_url,
       COUNT(DISTINCT owned.cell) AS cell_count,
       ci2.total_points AS global_points
     FROM (
       SELECT DISTINCT ON (cell) cell, user_id
       FROM (
         SELECT
           h3_cell_to_parent(h3_res14, 13) AS cell,
           user_id,
           SUM(points) AS pts,
           MIN(created_at) AS earliest
         FROM content_items
         GROUP BY 1, 2
       ) sub
       ORDER BY cell, pts DESC, earliest ASC
     ) owned
     JOIN user_profiles up ON up.id = owned.user_id
     JOIN (
       SELECT user_id, SUM(points) AS total_points
       FROM content_items
       GROUP BY user_id
     ) ci2 ON ci2.user_id = owned.user_id
     GROUP BY up.id, up.display_name, up.avatar_url, ci2.total_points
     ORDER BY cell_count DESC
     LIMIT $1`,
    [limit]
  );

  const users = rows.map(r => ({
    userId: r.user_id,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    cellCount: parseInt(r.cell_count),
    totalPoints: parseInt(r.global_points)
  }));

  const result = { users };
  cache.set(cacheKey, result, 60000);
  return result;
}

module.exports = { getViewportOwnership, getLeaderboard };
