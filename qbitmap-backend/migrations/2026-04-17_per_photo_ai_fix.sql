-- Fix for 2026-04-17_per_photo_ai.sql: PK swap on video_message_translations
-- failed because the FK on (message_id) prevented dropping the old PK.
-- We drop FK + swap PK + re-add FK in a single atomic ALTER, then run the
-- backfill that was skipped.

ALTER TABLE video_message_translations
  DROP FOREIGN KEY fk_vmsg_trans_message,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (message_id, photo_idx, lang),
  ADD CONSTRAINT fk_vmsg_trans_message FOREIGN KEY (message_id)
    REFERENCES video_messages(message_id) ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: mirror parent ai_description into video_message_photos[idx=0]
UPDATE video_message_photos vmp
JOIN video_messages vm ON vm.id = vmp.video_message_id
SET vmp.ai_description = vm.ai_description,
    vmp.ai_description_lang = vm.ai_description_lang
WHERE vmp.idx = 0
  AND vm.ai_description IS NOT NULL
  AND vmp.ai_description IS NULL;
