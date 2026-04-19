-- Global face library and absence alarms.
-- Replaces per-camera camera_faces rows with a user-level user_faces table.
-- Detection scope and alarm trigger become user-level, matching the
-- matcher service which already indexes globally.
-- Runner treats errnos 1060 1061 1826 1091 as already-applied, so this
-- migration is safe to re-run.

CREATE TABLE IF NOT EXISTS user_faces (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  person_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  face_image_url TEXT,
  trigger_alarm TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_person (user_id, person_id),
  INDEX idx_uf_user (user_id),
  CONSTRAINT fk_uf_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE face_detection_log
  ADD COLUMN user_face_id INT UNSIGNED NULL AFTER face_id;

ALTER TABLE face_detection_log
  ADD INDEX idx_fdl_user_face (user_face_id, detected_at);

ALTER TABLE face_detection_log
  ADD CONSTRAINT fk_fdl_uf FOREIGN KEY (user_face_id) REFERENCES user_faces(id) ON DELETE SET NULL;

-- Migrate existing camera_faces to user_faces (dedupe on user + person_id).
-- Legacy camera_faces table is left in place as a rollback path.
INSERT INTO user_faces (user_id, person_id, name, face_image_url, trigger_alarm, created_at)
SELECT c.user_id, cf.person_id, MAX(cf.name), MAX(cf.face_image_url),
       MAX(cf.trigger_alarm), MIN(cf.created_at)
FROM camera_faces cf
JOIN cameras c ON c.id = cf.camera_id
GROUP BY c.user_id, cf.person_id
ON DUPLICATE KEY UPDATE trigger_alarm = GREATEST(user_faces.trigger_alarm, VALUES(trigger_alarm));

-- Backfill face_detection_log.user_face_id for historical rows so absence
-- queries can rely on this column instead of joining through the legacy
-- camera_faces table.
UPDATE face_detection_log l
JOIN camera_faces cf ON cf.id = l.face_id
JOIN cameras c ON c.id = cf.camera_id
JOIN user_faces uf ON uf.user_id = c.user_id AND uf.person_id = cf.person_id
SET l.user_face_id = uf.id
WHERE l.user_face_id IS NULL;

-- Adjustable match threshold per camera (was hardcoded 70 in client).
ALTER TABLE cameras
  ADD COLUMN face_match_threshold TINYINT UNSIGNED NOT NULL DEFAULT 70 AFTER face_detection_interval;

-- Absence alarm rules (user-level, scoped to all user's cameras).
CREATE TABLE IF NOT EXISTS face_absence_rules (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  user_face_id INT UNSIGNED NOT NULL,
  label VARCHAR(255),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  day_of_week_mask TINYINT UNSIGNED NOT NULL DEFAULT 127,
  enabled TINYINT(1) DEFAULT 1,
  voice_call_enabled TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_far_user (user_id),
  INDEX idx_far_enabled_end (enabled, end_time),
  CONSTRAINT fk_far_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_far_face FOREIGN KEY (user_face_id) REFERENCES user_faces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Idempotency ledger for absence events. (rule_id, window_date) unique so
-- a cron tick that happens to run twice in the same minute can't double-fire.
CREATE TABLE IF NOT EXISTS face_absence_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  rule_id INT UNSIGNED NOT NULL,
  window_date DATE NOT NULL,
  triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at DATETIME NULL,
  UNIQUE KEY uk_rule_date (rule_id, window_date),
  INDEX idx_fae_triggered (triggered_at),
  CONSTRAINT fk_fae_rule FOREIGN KEY (rule_id) REFERENCES face_absence_rules(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
