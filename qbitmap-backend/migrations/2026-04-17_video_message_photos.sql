-- Multi-photo support for video_messages (foto mesaj 1-5 fotoğraf)
-- Parent video_messages.file_path / thumbnail_path / photo_metadata = kapak (idx=0) için ayna
-- Eski tek-fotolu mesajlar backfill ile idx=0 child satırı kazanır.

CREATE TABLE IF NOT EXISTS video_message_photos (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  video_message_id BIGINT UNSIGNED NOT NULL,
  idx TINYINT UNSIGNED NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  thumbnail_path VARCHAR(500) DEFAULT NULL,
  photo_metadata JSON DEFAULT NULL,
  file_size INT UNSIGNED NOT NULL,
  mime_type VARCHAR(50) NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_vmp_msg_idx (video_message_id, idx),
  INDEX idx_vmp_msg (video_message_id),
  CONSTRAINT fk_vmp_vmsg FOREIGN KEY (video_message_id)
    REFERENCES video_messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO video_message_photos
  (video_message_id, idx, file_path, thumbnail_path, photo_metadata, file_size, mime_type, is_primary)
SELECT id, 0, file_path, thumbnail_path, photo_metadata, file_size, mime_type, 1
FROM video_messages
WHERE media_type = 'photo';
