-- Per-photo AI analysis support
-- 1) video_message_photos: per-photo AI fields
ALTER TABLE video_message_photos
  ADD COLUMN ai_description TEXT NULL AFTER photo_metadata,
  ADD COLUMN ai_description_lang VARCHAR(8) NULL AFTER ai_description;

-- 2) ai_jobs: sub_id + composite UNIQUE (replaces old single-message UNIQUE)
ALTER TABLE ai_jobs
  ADD COLUMN sub_id INT UNSIGNED NOT NULL DEFAULT 0 AFTER message_id;

ALTER TABLE ai_jobs DROP INDEX uk_aijobs_message;

ALTER TABLE ai_jobs ADD UNIQUE KEY uk_aijobs_msg_sub (message_id, sub_id);

-- 3) video_message_translations: photo_idx + composite PK
ALTER TABLE video_message_translations
  ADD COLUMN photo_idx TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER message_id;

ALTER TABLE video_message_translations DROP PRIMARY KEY;

ALTER TABLE video_message_translations
  ADD PRIMARY KEY (message_id, photo_idx, lang);

-- 4) Backfill: kapak ai_description varsa video_message_photos[idx=0]'a kopyala
UPDATE video_message_photos vmp
JOIN video_messages vm ON vm.id = vmp.video_message_id
SET vmp.ai_description = vm.ai_description,
    vmp.ai_description_lang = vm.ai_description_lang
WHERE vmp.idx = 0
  AND vm.ai_description IS NOT NULL
  AND vmp.ai_description IS NULL;
