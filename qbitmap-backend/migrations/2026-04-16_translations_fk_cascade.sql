-- Faz 1 #4: video_message_translations garbage collection via FK CASCADE
--
-- Before: deleteVideoMessage removed rows from video_messages but left orphan
-- rows behind in video_message_translations because no FK was declared and
-- clearVideoMessageTranslations() was never invoked from the delete path.
-- Translations table would grow without bound, carrying data for
-- long-deleted messages.
--
-- After: FK ON DELETE CASCADE guarantees translations disappear the moment
-- their parent message is deleted. Zero data loss — only rows referencing
-- already-deleted messages are purged.
--
-- Re-run safety: relies on the migration runner's idempotency handling
-- (errno 1061 duplicate index, 1826 duplicate FK → treated as applied).

-- 1. Purge existing orphan translations (parent message already gone)
DELETE t FROM video_message_translations t
LEFT JOIN video_messages v ON v.message_id = t.message_id
WHERE v.message_id IS NULL;

-- 2. Ensure idx_vmt_tag exists on video_message_tags(tag_id).
--    Older deployments predate the schema.sql declaration. If the index
--    already exists, errno 1061 is treated as "already applied" by runner.
ALTER TABLE video_message_tags ADD INDEX idx_vmt_tag (tag_id);

-- 3. Add FK with CASCADE on video_message_translations.message_id.
--    Re-run returns errno 1826 (duplicate FK) which runner treats as applied.
ALTER TABLE video_message_translations
  ADD CONSTRAINT fk_vmsg_trans_message
  FOREIGN KEY (message_id) REFERENCES video_messages(message_id)
  ON DELETE CASCADE ON UPDATE CASCADE;
