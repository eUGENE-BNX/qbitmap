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

async function getUserStats(userId) {
  const cacheKey = `ustats:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Total points
  const { rows: pointRows } = await pool.query(
    'SELECT COALESCE(SUM(points), 0) AS total_points FROM content_items WHERE user_id = $1',
    [userId]
  );

  // Owned cells at resolution 13
  const { rows: cellRows } = await pool.query(
    `SELECT COUNT(*) AS cell_count FROM (
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
     WHERE user_id = $1`,
    [userId]
  );

  // Rank
  const { rows: rankRows } = await pool.query(
    `SELECT rank FROM (
       SELECT user_id, ROW_NUMBER() OVER (ORDER BY cell_count DESC) AS rank
       FROM (
         SELECT owned.user_id, COUNT(*) AS cell_count
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
         GROUP BY owned.user_id
       ) counts
     ) ranked
     WHERE user_id = $1`,
    [userId]
  );

  const cellCount = parseInt(cellRows[0]?.cell_count || 0);
  // H3 resolution 13 average cell area
  const H3_RES13_AREA_M2 = 43.87;

  const result = {
    userId,
    totalPoints: parseInt(pointRows[0]?.total_points || 0),
    cellCount,
    totalAreaM2: Math.round(cellCount * H3_RES13_AREA_M2),
    rank: parseInt(rankRows[0]?.rank || 0)
  };

  cache.set(cacheKey, result, 60000);
  return result;
}

module.exports = { getViewportOwnership, getLeaderboard, getUserStats };
