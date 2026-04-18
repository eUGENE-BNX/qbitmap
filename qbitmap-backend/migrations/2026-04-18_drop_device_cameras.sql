-- Drop ESP32 device cameras and related schema.
-- Device cameras (camera_type = 'device') are retired. Remaining camera
-- types are 'whep' (user RTSP/RTMP/WHEP) and 'city' (HLS).
--
-- The migration runner treats errno 1091 (can't drop — already gone) and
-- 1060/1061 (duplicate column/index) as already-applied, so re-running is
-- safe. We still guard with IF EXISTS / IF NOT EXISTS where MySQL accepts
-- it.

-- 1. Delete settings rows for device cameras first (FK to cameras)
DELETE FROM camera_settings
  WHERE camera_id IN (SELECT id FROM cameras WHERE camera_type = 'device');

-- 2. Delete device camera rows themselves
DELETE FROM cameras WHERE camera_type = 'device';

-- 3. Drop indexes that reference columns we're about to remove
ALTER TABLE cameras DROP INDEX idx_cameras_user_lastseen;
ALTER TABLE cameras DROP INDEX idx_cameras_last_seen;

-- 4. Drop device-only columns
ALTER TABLE cameras DROP COLUMN stream_mode;
ALTER TABLE cameras DROP COLUMN last_seen;

-- 5. Flip camera_type default so new inserts land on 'whep' instead of 'device'
ALTER TABLE cameras MODIFY camera_type VARCHAR(50) DEFAULT 'whep';
