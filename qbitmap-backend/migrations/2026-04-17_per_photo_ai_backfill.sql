-- Backfill skipped during the original per_photo_ai migration:
-- mirror parent video_messages.ai_description into video_message_photos[idx=0]
-- so old single-photo messages don't lose their existing AI text.
-- Idempotent via WHERE vmp.ai_description IS NULL filter.
UPDATE video_message_photos vmp
JOIN video_messages vm ON vm.id = vmp.video_message_id
SET vmp.ai_description = vm.ai_description,
    vmp.ai_description_lang = vm.ai_description_lang
WHERE vmp.idx = 0
  AND vm.ai_description IS NOT NULL
  AND vmp.ai_description IS NULL;
