-- User stats columns for tooltip display
-- Run on qbitmap_h3 PostgreSQL database

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS video_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS photo_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_views INT DEFAULT 0;
