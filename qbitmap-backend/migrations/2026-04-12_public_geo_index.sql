-- PERF-16: composite index for public camera geo queries
-- Covers: WHERE is_public=1 AND camera_type<>'city' AND lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?
-- Uses ALTER TABLE ADD INDEX which is supported by the migration runner's
-- 1061 (duplicate key name) handler if re-run.
ALTER TABLE cameras ADD INDEX idx_cameras_public_geo (is_public, camera_type, lng, lat);
