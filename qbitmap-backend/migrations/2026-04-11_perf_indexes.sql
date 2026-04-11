-- Composite index for geo+temporal queries (cursor pagination + bounds)
-- Covers: WHERE created_at < cursor AND lng BETWEEN .. AND lat BETWEEN ..
ALTER TABLE video_messages ADD INDEX idx_vmsg_created_geo (created_at DESC, lng, lat);

-- FULLTEXT index on translations table for multilingual search
ALTER TABLE video_message_translations ADD FULLTEXT INDEX ft_vmsg_trans (text);
