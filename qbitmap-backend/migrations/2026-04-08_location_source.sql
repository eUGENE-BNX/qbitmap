-- Migration: add location source + accuracy radius columns
-- Date: 2026-04-08
-- Run on production DB once. All columns are nullable so existing rows are unaffected.

ALTER TABLE users
  ADD COLUMN last_location_source VARCHAR(16) NULL AFTER last_location_accuracy;

ALTER TABLE live_broadcasts
  ADD COLUMN accuracy_radius_m INT UNSIGNED NULL AFTER lat,
  ADD COLUMN location_source VARCHAR(16) NULL AFTER accuracy_radius_m;

ALTER TABLE video_messages
  ADD COLUMN accuracy_radius_m INT UNSIGNED NULL AFTER lat,
  ADD COLUMN location_source VARCHAR(16) NULL AFTER accuracy_radius_m;
