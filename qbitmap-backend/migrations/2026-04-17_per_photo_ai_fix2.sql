-- Fix #2: previous compound ALTER was rejected as "schema matches" without
-- actually swapping the PK. This version uses separate statements so the
-- migration runner can apply (or skip-as-idempotent) each one independently.

ALTER TABLE video_message_translations DROP FOREIGN KEY fk_vmsg_trans_message;

ALTER TABLE video_message_translations DROP PRIMARY KEY;

ALTER TABLE video_message_translations ADD PRIMARY KEY (message_id, photo_idx, lang);

ALTER TABLE video_message_translations ADD CONSTRAINT fk_vmsg_trans_message FOREIGN KEY (message_id) REFERENCES video_messages(message_id) ON DELETE CASCADE ON UPDATE CASCADE;
