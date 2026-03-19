-- Digital Land Ownership tables
-- Run on qbitmap_h3 PostgreSQL database

-- Unified content items for ownership scoring
CREATE TABLE IF NOT EXISTS content_items (
  id SERIAL PRIMARY KEY,
  item_type VARCHAR(20) NOT NULL,        -- 'camera', 'video', 'photo'
  item_id VARCHAR(255) NOT NULL UNIQUE,  -- device_id or message_id
  user_id INT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  h3_res14 H3INDEX NOT NULL,
  points INT NOT NULL,                   -- 50, 5, or 1
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_h3 ON content_items(h3_res14);
CREATE INDEX IF NOT EXISTS idx_content_user ON content_items(user_id);
CREATE INDEX IF NOT EXISTS idx_content_geo ON content_items(lat, lng);
CREATE INDEX IF NOT EXISTS idx_content_type ON content_items(item_type);

-- Minimal user profile cache (synced from backend)
CREATE TABLE IF NOT EXISTS user_profiles (
  id INT PRIMARY KEY,                    -- matches backend users.id
  display_name VARCHAR(255),
  avatar_url TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);
