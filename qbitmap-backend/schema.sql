-- QBitmap MySQL Schema
-- Migrated from SQLite - InnoDB engine, utf8mb4 charset
-- Run with: mysql -u qbitmap -p qbitmap < schema.sql

SET FOREIGN_KEY_CHECKS = 0;
SET NAMES utf8mb4;

-- =================================================================
-- 1. user_plans
-- =================================================================
CREATE TABLE IF NOT EXISTS user_plans (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  max_cameras INT DEFAULT 2,
  max_whep_cameras INT DEFAULT 1,
  ai_analysis_enabled TINYINT(1) DEFAULT 0,
  ai_daily_limit INT DEFAULT 0,
  face_recognition_enabled TINYINT(1) DEFAULT 0,
  max_faces_per_camera INT DEFAULT 0,
  recording_enabled TINYINT(1) DEFAULT 0,
  max_recording_hours INT DEFAULT 0,
  recording_retention_days INT DEFAULT 7,
  voice_call_enabled TINYINT(1) DEFAULT 0,
  face_login_enabled TINYINT(1) DEFAULT 0,
  voice_control_enabled TINYINT(1) DEFAULT 0,
  public_sharing_enabled TINYINT(1) DEFAULT 0,
  priority_support TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 2. users
-- =================================================================
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  google_id VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(255),
  avatar_url TEXT,
  face_image_path TEXT,
  face_api_person_id VARCHAR(255),
  plan_id INT UNSIGNED DEFAULT 1,
  role VARCHAR(20) DEFAULT 'user',
  is_active TINYINT(1) DEFAULT 1,
  token_version INT UNSIGNED NOT NULL DEFAULT 1,
  last_login DATETIME,
  notes TEXT,
  auth_provider VARCHAR(50) DEFAULT 'google',
  last_lat DOUBLE,
  last_lng DOUBLE,
  last_location_accuracy DOUBLE,
  last_location_source VARCHAR(16),
  last_location_updated DATETIME,
  show_location_on_map TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_face_api_person_id (face_api_person_id),
  INDEX idx_users_plan_id (plan_id),
  INDEX idx_users_role (role),
  CONSTRAINT fk_users_plan FOREIGN KEY (plan_id) REFERENCES user_plans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 3. cameras
-- =================================================================
CREATE TABLE IF NOT EXISTS cameras (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id VARCHAR(255) UNIQUE NOT NULL,
  user_id INT UNSIGNED,
  name VARCHAR(255) DEFAULT 'My Camera',
  lng DOUBLE,
  lat DOUBLE,
  is_public TINYINT(1) DEFAULT 0,
  camera_type VARCHAR(50) DEFAULT 'whep',
  whep_url TEXT,
  voice_call_enabled TINYINT(1) DEFAULT 0,
  audio_muted TINYINT(1) DEFAULT 0,
  mediamtx_path VARCHAR(255),
  onvif_camera_id VARCHAR(255),
  rtsp_source_url TEXT,
  face_detection_enabled TINYINT(1) DEFAULT 0,
  face_detection_interval INT DEFAULT 10,
  face_match_threshold TINYINT UNSIGNED NOT NULL DEFAULT 70,
  alarm_trigger_names TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_cameras_user (user_id),
  INDEX idx_cameras_public (is_public),
  INDEX idx_cameras_mediamtx_path (mediamtx_path),
  INDEX idx_cameras_onvif_camera_id (onvif_camera_id),
  INDEX idx_cameras_user_public (user_id, is_public),
  INDEX idx_cameras_user_type (user_id, camera_type),
  INDEX idx_cameras_public_geo (is_public, camera_type, lng, lat),
  CONSTRAINT fk_cameras_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 4. live_broadcasts
-- =================================================================
CREATE TABLE IF NOT EXISTS live_broadcasts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  broadcast_id VARCHAR(255) UNIQUE NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  display_name VARCHAR(255),
  avatar_url TEXT,
  mediamtx_path VARCHAR(255) NOT NULL,
  whep_url TEXT NOT NULL,
  lng DOUBLE NOT NULL,
  lat DOUBLE NOT NULL,
  accuracy_radius_m INT UNSIGNED,
  location_source VARCHAR(16),
  orientation VARCHAR(20) DEFAULT 'landscape',
  status VARCHAR(50) DEFAULT 'active',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,
  INDEX idx_live_broadcasts_status (status),
  INDEX idx_live_broadcasts_user (user_id, status),
  CONSTRAINT fk_broadcasts_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 5. camera_settings
-- =================================================================
CREATE TABLE IF NOT EXISTS camera_settings (
  camera_id INT UNSIGNED PRIMARY KEY,
  settings_json TEXT NOT NULL,
  config_version INT DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_settings_camera FOREIGN KEY (camera_id) REFERENCES cameras(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. frames — DROPPED (ARCH-18). Was deprecated (memory cache only).
-- See migrations/2026-04-12_drop_frames.sql.

-- =================================================================
-- 7. user_usage
-- =================================================================
CREATE TABLE IF NOT EXISTS user_usage (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  usage_date DATE NOT NULL,
  ai_analysis_count INT DEFAULT 0,
  face_recognition_count INT DEFAULT 0,
  recording_minutes INT DEFAULT 0,
  voice_call_count INT DEFAULT 0,
  UNIQUE KEY uk_user_usage (user_id, usage_date),
  INDEX idx_user_usage_user_date (user_id, usage_date DESC),
  INDEX idx_user_usage_date (usage_date),
  CONSTRAINT fk_usage_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 8. user_feature_overrides
-- =================================================================
CREATE TABLE IF NOT EXISTS user_feature_overrides (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED UNIQUE NOT NULL,
  max_cameras INT,
  max_whep_cameras INT,
  ai_analysis_enabled TINYINT(1),
  ai_daily_limit INT,
  face_recognition_enabled TINYINT(1),
  max_faces_per_camera INT,
  recording_enabled TINYINT(1),
  max_recording_hours INT,
  recording_retention_days INT,
  voice_call_enabled TINYINT(1),
  face_login_enabled TINYINT(1),
  voice_control_enabled TINYINT(1),
  public_sharing_enabled TINYINT(1),
  notes TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_overrides_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 9. camera_shares
-- =================================================================
CREATE TABLE IF NOT EXISTS camera_shares (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  camera_id INT UNSIGNED NOT NULL,
  shared_with_user_id INT UNSIGNED NOT NULL,
  permission VARCHAR(50) DEFAULT 'view',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_camera_share (camera_id, shared_with_user_id),
  INDEX idx_camera_shares_user (shared_with_user_id),
  INDEX idx_camera_shares_camera (camera_id),
  CONSTRAINT fk_shares_camera FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE,
  CONSTRAINT fk_shares_user FOREIGN KEY (shared_with_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 10. ai_monitoring
-- =================================================================
CREATE TABLE IF NOT EXISTS ai_monitoring (
  camera_id INT UNSIGNED PRIMARY KEY,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  started_by_user_id INT UNSIGNED,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_analysis_at DATETIME,
  config_version INT DEFAULT 1,
  INDEX idx_ai_monitoring_enabled (enabled),
  CONSTRAINT fk_ai_camera FOREIGN KEY (camera_id) REFERENCES cameras(id),
  CONSTRAINT fk_ai_user FOREIGN KEY (started_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 11. alarms
-- =================================================================
CREATE TABLE IF NOT EXISTS alarms (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  camera_id INT UNSIGNED NOT NULL,
  device_id VARCHAR(255) NOT NULL,
  alarm_data TEXT NOT NULL,
  triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  cleared_at DATETIME,
  cleared_by_user_id INT UNSIGNED,
  acknowledged TINYINT(1) DEFAULT 0,
  INDEX idx_alarms_camera_triggered (camera_id, triggered_at DESC),
  INDEX idx_alarms_active (camera_id, cleared_at),
  INDEX idx_alarms_device (device_id),
  CONSTRAINT fk_alarms_camera FOREIGN KEY (camera_id) REFERENCES cameras(id),
  CONSTRAINT fk_alarms_cleared_by FOREIGN KEY (cleared_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 12. onvif_camera_templates
-- =================================================================
CREATE TABLE IF NOT EXISTS onvif_camera_templates (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  model_name VARCHAR(255) NOT NULL UNIQUE,
  manufacturer VARCHAR(255) NOT NULL,
  onvif_port INT DEFAULT 2020,
  supported_events TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 13. camera_onvif_links
-- =================================================================
CREATE TABLE IF NOT EXISTS camera_onvif_links (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  qbitmap_camera_id INT UNSIGNED NOT NULL UNIQUE,
  onvif_camera_id VARCHAR(255) NOT NULL,
  onvif_template_id INT UNSIGNED NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_onvif_links_onvif_id (onvif_camera_id),
  CONSTRAINT fk_onvif_link_camera FOREIGN KEY (qbitmap_camera_id) REFERENCES cameras(id) ON DELETE CASCADE,
  CONSTRAINT fk_onvif_link_template FOREIGN KEY (onvif_template_id) REFERENCES onvif_camera_templates(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 14. onvif_events
-- =================================================================
CREATE TABLE IF NOT EXISTS onvif_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  camera_id INT UNSIGNED NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  event_state TINYINT(1) NOT NULL,
  event_data TEXT,
  `timestamp` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_onvif_events_camera_time (camera_id, `timestamp` DESC),
  INDEX idx_onvif_events_type (event_type),
  INDEX idx_onvif_events_camera_state (camera_id, event_state),
  INDEX idx_onvif_events_time (`timestamp`),
  CONSTRAINT fk_onvif_events_camera FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 15. camera_faces
-- =================================================================
CREATE TABLE IF NOT EXISTS camera_faces (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  camera_id INT UNSIGNED NOT NULL,
  person_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  face_image_url TEXT,
  trigger_alarm TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_camera_faces_camera_id (camera_id),
  INDEX idx_camera_faces_camera_person (camera_id, person_id),
  CONSTRAINT fk_faces_camera FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 16. face_detection_log
-- =================================================================
-- =================================================================
-- 15b. user_faces (global per-user face library)
-- =================================================================
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

CREATE TABLE IF NOT EXISTS face_detection_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  camera_id INT UNSIGNED NOT NULL,
  face_id INT UNSIGNED,
  user_face_id INT UNSIGNED,
  person_name VARCHAR(255),
  confidence DOUBLE,
  detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_face_log_camera (camera_id, detected_at DESC),
  INDEX idx_face_log_time (detected_at),
  INDEX idx_fdl_user_face (user_face_id, detected_at),
  CONSTRAINT fk_face_log_camera FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE,
  CONSTRAINT fk_face_log_face FOREIGN KEY (face_id) REFERENCES camera_faces(id) ON DELETE SET NULL,
  CONSTRAINT fk_fdl_uf FOREIGN KEY (user_face_id) REFERENCES user_faces(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 16c. face_absence_rules (recurring time windows to watch for absences)
-- =================================================================
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

-- =================================================================
-- 16d. face_absence_events (idempotency ledger — one row per rule/day)
-- =================================================================
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

-- =================================================================
-- 17. clickable_zones
-- =================================================================
CREATE TABLE IF NOT EXISTS clickable_zones (
  id VARCHAR(100) PRIMARY KEY,
  camera_id VARCHAR(255) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  points TEXT NOT NULL,
  relay_on_url TEXT,
  relay_off_url TEXT,
  relay_status_url TEXT,
  last_state VARCHAR(50) DEFAULT 'unknown',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_zones_camera (camera_id),
  INDEX idx_zones_user (user_id),
  CONSTRAINT fk_zones_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 18. system_settings
-- =================================================================
CREATE TABLE IF NOT EXISTS system_settings (
  `key` VARCHAR(255) PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 19. active_recordings
-- =================================================================
CREATE TABLE IF NOT EXISTS active_recordings (
  camera_id VARCHAR(255) PRIMARY KEY,
  path_name VARCHAR(255) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  max_duration_ms INT DEFAULT 3600000
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 20. video_messages
-- =================================================================
CREATE TABLE IF NOT EXISTS video_messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(64) UNIQUE NOT NULL,
  sender_id INT UNSIGNED NOT NULL,
  recipient_id INT UNSIGNED,
  lng DOUBLE NOT NULL,
  lat DOUBLE NOT NULL,
  accuracy_radius_m INT UNSIGNED,
  location_source VARCHAR(16),
  file_path VARCHAR(500) NOT NULL,
  file_size INT UNSIGNED NOT NULL,
  duration_ms INT UNSIGNED DEFAULT NULL,
  mime_type VARCHAR(50) NOT NULL DEFAULT 'video/mp4',
  media_type ENUM('video','photo') NOT NULL DEFAULT 'video',
  description VARCHAR(200) DEFAULT NULL,
  ai_description TEXT DEFAULT NULL,
  ai_description_lang VARCHAR(8) DEFAULT NULL,
  thumbnail_path VARCHAR(500) DEFAULT NULL,
  photo_metadata JSON DEFAULT NULL,
  place_id INT UNSIGNED DEFAULT NULL,
  is_read TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_vmsg_sender (sender_id),
  INDEX idx_vmsg_recipient (recipient_id, is_read),
  INDEX idx_vmsg_location (lng, lat),
  INDEX idx_vmsg_public (recipient_id, created_at DESC),
  INDEX idx_vmsg_media_type (media_type),
  INDEX idx_vmsg_place (place_id),
  FULLTEXT INDEX ft_vmsg_text (description, ai_description),
  INDEX idx_vmsg_created_geo (created_at DESC, lng, lat),
  CONSTRAINT fk_vmsg_sender FOREIGN KEY (sender_id) REFERENCES users(id),
  CONSTRAINT fk_vmsg_recipient FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_vmsg_place FOREIGN KEY (place_id) REFERENCES google_places(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 20a. video_message_photos (multi-photo per message, idx=0 = kapak)
-- =================================================================
CREATE TABLE IF NOT EXISTS video_message_photos (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  video_message_id BIGINT UNSIGNED NOT NULL,
  idx TINYINT UNSIGNED NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  thumbnail_path VARCHAR(500) DEFAULT NULL,
  photo_metadata JSON DEFAULT NULL,
  ai_description TEXT DEFAULT NULL,
  ai_description_lang VARCHAR(8) DEFAULT NULL,
  file_size INT UNSIGNED NOT NULL,
  mime_type VARCHAR(50) NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_vmp_msg_idx (video_message_id, idx),
  INDEX idx_vmp_msg (video_message_id),
  CONSTRAINT fk_vmp_vmsg FOREIGN KEY (video_message_id)
    REFERENCES video_messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 21. tags (for video message tagging)
-- =================================================================
CREATE TABLE IF NOT EXISTS tags (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  UNIQUE KEY uk_tag_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 22. video_message_tags (many-to-many junction)
-- =================================================================
CREATE TABLE IF NOT EXISTS video_message_tags (
  video_message_id BIGINT UNSIGNED NOT NULL,
  tag_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (video_message_id, tag_id),
  INDEX idx_vmt_tag (tag_id),
  CONSTRAINT fk_vmt_vmsg FOREIGN KEY (video_message_id)
    REFERENCES video_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_vmt_tag FOREIGN KEY (tag_id)
    REFERENCES tags(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 23. view_counts (generic, reusable for video_message, camera, etc.)
-- =================================================================
CREATE TABLE IF NOT EXISTS view_counts (
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  view_count INT UNSIGNED DEFAULT 0,
  PRIMARY KEY (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 24. comments (generic, reusable for video_message, camera, etc.)
-- =================================================================
CREATE TABLE IF NOT EXISTS comments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  content VARCHAR(500) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_comments_entity (entity_type, entity_id, created_at DESC),
  INDEX idx_comments_user (user_id),
  CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- PERFORMANCE INDEXES (added 2026-02-20)
-- =================================================================
-- cameras table - frequently filtered columns
CREATE INDEX IF NOT EXISTS idx_cameras_camera_type ON cameras(camera_type);
CREATE INDEX IF NOT EXISTS idx_cameras_face_detection ON cameras(face_detection_enabled);
CREATE INDEX IF NOT EXISTS idx_cameras_voice_call ON cameras(voice_call_enabled);

-- alarms table - active alarm queries filter on cleared_at IS NULL
CREATE INDEX IF NOT EXISTS idx_alarms_cleared_at ON alarms(cleared_at);

-- live_broadcasts table - status filtering
CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON live_broadcasts(status);

-- video_messages table - recipient queries
CREATE INDEX IF NOT EXISTS idx_video_messages_recipient ON video_messages(recipient_id);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_cameras_user_type ON cameras(user_id, camera_type);
CREATE INDEX IF NOT EXISTS idx_alarms_camera_cleared ON alarms(camera_id, cleared_at);
CREATE INDEX IF NOT EXISTS idx_video_messages_sender ON video_messages(sender_id, created_at);

-- =================================================================
-- 25. google_places (cached place data from Google Places API)
-- =================================================================
CREATE TABLE IF NOT EXISTS google_places (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  google_place_id VARCHAR(255) NOT NULL,
  display_name VARCHAR(500) NOT NULL,
  formatted_address VARCHAR(500) DEFAULT NULL,
  lat DOUBLE NOT NULL,
  lng DOUBLE NOT NULL,
  types JSON DEFAULT NULL,
  icon_url VARCHAR(500) DEFAULT NULL,
  business_status VARCHAR(50) DEFAULT NULL,
  rating DECIMAL(2,1) DEFAULT NULL,
  user_ratings_total INT UNSIGNED DEFAULT 0,
  cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_google_place_id (google_place_id),
  INDEX idx_gp_location (lat, lng)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 26. places_cache_cells (tracks which geographic cells have been queried)
-- =================================================================
CREATE TABLE IF NOT EXISTS places_cache_cells (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  cell_lat DECIMAL(7,4) NOT NULL,
  cell_lng DECIMAL(7,4) NOT NULL,
  radius_m SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  queried_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  result_count TINYINT UNSIGNED DEFAULT 0,
  UNIQUE KEY uk_cell (cell_lat, cell_lng, radius_m)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 27. places_cache_cell_places (junction: which places belong to which cell)
-- =================================================================
CREATE TABLE IF NOT EXISTS places_cache_cell_places (
  cell_id INT UNSIGNED NOT NULL,
  place_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (cell_id, place_id),
  CONSTRAINT fk_pccp_cell FOREIGN KEY (cell_id) REFERENCES places_cache_cells(id) ON DELETE CASCADE,
  CONSTRAINT fk_pccp_place FOREIGN KEY (place_id) REFERENCES google_places(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 28. likes (generic like/unlike per user per entity)
-- =================================================================
CREATE TABLE IF NOT EXISTS likes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_likes_user_entity (entity_type, entity_id, user_id),
  INDEX idx_likes_entity (entity_type, entity_id),
  INDEX idx_likes_user (user_id),
  CONSTRAINT fk_likes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 29. like_counts (denormalized counter for fast reads)
-- =================================================================
CREATE TABLE IF NOT EXISTS like_counts (
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  like_count INT UNSIGNED DEFAULT 0,
  PRIMARY KEY (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 30. ai_jobs (persistent queue for AI analysis)
-- =================================================================
CREATE TABLE IF NOT EXISTS ai_jobs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(64) NOT NULL,
  sub_id INT UNSIGNED NOT NULL DEFAULT 0,
  job_type ENUM('photo', 'video') NOT NULL,
  status ENUM('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  retries TINYINT UNSIGNED DEFAULT 0,
  max_retries TINYINT UNSIGNED DEFAULT 2,
  error_message TEXT DEFAULT NULL,
  next_retry_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at DATETIME DEFAULT NULL,
  INDEX idx_aijobs_status (status, next_retry_at),
  INDEX idx_aijobs_message (message_id),
  UNIQUE KEY uk_aijobs_msg_sub (message_id, sub_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 31. geo_lang_cells (coord → language cache for AI prompt localization)
-- =================================================================
CREATE TABLE IF NOT EXISTS geo_lang_cells (
  cell_key VARCHAR(24) PRIMARY KEY,
  country_code VARCHAR(2) DEFAULT NULL,
  subdivision_code VARCHAR(8) DEFAULT NULL,
  lang_code VARCHAR(8) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 32. video_message_translations (cached on-demand translations)
-- =================================================================
CREATE TABLE IF NOT EXISTS video_message_translations (
  message_id VARCHAR(64) NOT NULL,
  photo_idx TINYINT UNSIGNED NOT NULL DEFAULT 0,
  lang VARCHAR(8) NOT NULL,
  text VARCHAR(1200) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, photo_idx, lang),
  FULLTEXT INDEX ft_vmsg_trans (text),
  CONSTRAINT fk_vmsg_trans_message FOREIGN KEY (message_id)
    REFERENCES video_messages(message_id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- Performance indexes (added during optimization)
-- =================================================================
CREATE INDEX IF NOT EXISTS idx_video_messages_place ON video_messages(place_id);
CREATE INDEX IF NOT EXISTS idx_comments_entity_user ON comments(entity_type, entity_id, user_id);
CREATE INDEX IF NOT EXISTS idx_alarms_user ON alarms(user_id);
CREATE INDEX IF NOT EXISTS idx_cameras_public_type ON cameras(is_public, camera_type);

-- =================================================================
-- 31. reports (generic content reporting/flagging)
-- =================================================================
CREATE TABLE IF NOT EXISTS reports (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  reason VARCHAR(50) NOT NULL,
  detail VARCHAR(500) DEFAULT NULL,
  status ENUM('pending', 'resolved', 'dismissed') NOT NULL DEFAULT 'pending',
  resolved_by INT UNSIGNED DEFAULT NULL,
  resolved_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_reports_user_entity (entity_type, entity_id, user_id),
  INDEX idx_reports_status (status, created_at DESC),
  INDEX idx_reports_entity (entity_type, entity_id),
  INDEX idx_reports_user (user_id),
  CONSTRAINT fk_reports_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 32. report_counts (denormalized counter for fast reads)
-- =================================================================
CREATE TABLE IF NOT EXISTS report_counts (
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  report_count INT UNSIGNED DEFAULT 0,
  PRIMARY KEY (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 33. tesla_accounts (links qbitmap user to Tesla account)
-- =================================================================
CREATE TABLE IF NOT EXISTS tesla_accounts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  tesla_user_id VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  full_name VARCHAR(255),
  profile_image_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_tesla_accounts_user (user_id),
  UNIQUE INDEX idx_tesla_accounts_tesla (tesla_user_id),
  CONSTRAINT fk_tesla_accounts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 34. tesla_tokens (OAuth2 access/refresh tokens, encrypted)
-- =================================================================
CREATE TABLE IF NOT EXISTS tesla_tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tesla_account_id INT UNSIGNED NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_type VARCHAR(50) DEFAULT 'Bearer',
  expires_at DATETIME NOT NULL,
  scopes VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_tesla_tokens_account (tesla_account_id),
  CONSTRAINT fk_tesla_tokens_account FOREIGN KEY (tesla_account_id) REFERENCES tesla_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 35. tesla_vehicles (vehicle info + latest telemetry snapshot)
-- =================================================================
CREATE TABLE IF NOT EXISTS tesla_vehicles (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tesla_account_id INT UNSIGNED NOT NULL,
  vehicle_id VARCHAR(255) NOT NULL,
  vin VARCHAR(17) NOT NULL,
  display_name VARCHAR(255),
  model VARCHAR(50),
  car_type VARCHAR(50),
  color VARCHAR(50),
  license_plate VARCHAR(20) DEFAULT NULL,
  wheel_type VARCHAR(50),
  car_version VARCHAR(50),
  odometer DOUBLE DEFAULT NULL,
  last_lat DOUBLE DEFAULT NULL,
  last_lng DOUBLE DEFAULT NULL,
  last_soc TINYINT UNSIGNED DEFAULT NULL,
  last_gear VARCHAR(10) DEFAULT 'P',
  last_bearing DOUBLE DEFAULT 0,
  last_speed DOUBLE DEFAULT 0,
  last_tpms_fl DOUBLE DEFAULT NULL,
  last_tpms_fr DOUBLE DEFAULT NULL,
  last_tpms_rl DOUBLE DEFAULT NULL,
  last_tpms_rr DOUBLE DEFAULT NULL,
  last_inside_temp DOUBLE DEFAULT NULL,
  last_outside_temp DOUBLE DEFAULT NULL,
  last_est_range DOUBLE DEFAULT NULL,
  last_charge_limit TINYINT UNSIGNED DEFAULT NULL,
  last_locked TINYINT(1) DEFAULT NULL,
  last_sentry TINYINT(1) DEFAULT NULL,
  last_telemetry_at DATETIME DEFAULT NULL,
  is_online TINYINT(1) DEFAULT 0,
  telemetry_enabled TINYINT(1) DEFAULT 0,
  mesh_visible TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_tesla_vehicles_vid (vehicle_id),
  INDEX idx_tesla_vehicles_account (tesla_account_id),
  INDEX idx_tesla_vehicles_vin (vin),
  CONSTRAINT fk_tesla_vehicles_account FOREIGN KEY (tesla_account_id) REFERENCES tesla_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =================================================================
-- 28. broadcast_recordings
-- =================================================================
CREATE TABLE IF NOT EXISTS broadcast_recordings (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  recording_id VARCHAR(64) UNIQUE NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  broadcast_id VARCHAR(255) DEFAULT NULL,
  display_name VARCHAR(255),
  avatar_url TEXT,
  file_path VARCHAR(500) NOT NULL,
  file_size INT UNSIGNED DEFAULT 0,
  duration_ms INT UNSIGNED DEFAULT 0,
  thumbnail_path VARCHAR(500) DEFAULT NULL,
  lng DOUBLE NOT NULL,
  lat DOUBLE NOT NULL,
  orientation VARCHAR(20) DEFAULT 'landscape',
  is_public TINYINT(1) DEFAULT 0,
  show_on_map TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bcrec_user (user_id, created_at DESC),
  INDEX idx_bcrec_map (show_on_map, is_public),
  CONSTRAINT fk_bcrec_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
