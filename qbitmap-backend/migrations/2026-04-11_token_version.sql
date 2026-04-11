-- Migration: add token_version column for JWT revocation
-- Date: 2026-04-11
-- SEC-01: Allows logout / admin deactivation to immediately invalidate all
-- outstanding JWTs for a user. authHook rejects tokens whose tokenVersion
-- claim does not match the DB value. Bumped on logout and on setUserActive(false).

ALTER TABLE users
  ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 1 AFTER is_active;
