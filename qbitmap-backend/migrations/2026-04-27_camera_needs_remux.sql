ALTER TABLE cameras
  ADD COLUMN needs_remux BOOLEAN NOT NULL DEFAULT 0;

UPDATE cameras SET needs_remux = 1 WHERE id = 185;
