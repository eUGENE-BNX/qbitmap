-- Multi-language AI descriptions: source lang column, geo→lang cache, translation cache.

ALTER TABLE video_messages
  ADD COLUMN ai_description_lang VARCHAR(8) DEFAULT NULL AFTER ai_description;

-- Existing rows were all generated in Turkish.
UPDATE video_messages SET ai_description_lang = 'tr' WHERE ai_description IS NOT NULL AND ai_description_lang IS NULL;

CREATE TABLE IF NOT EXISTS geo_lang_cells (
  cell_key VARCHAR(24) PRIMARY KEY,
  country_code VARCHAR(2) DEFAULT NULL,
  subdivision_code VARCHAR(8) DEFAULT NULL,
  lang_code VARCHAR(8) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS video_message_translations (
  message_id VARCHAR(64) NOT NULL,
  lang VARCHAR(8) NOT NULL,
  text VARCHAR(1200) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, lang)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
