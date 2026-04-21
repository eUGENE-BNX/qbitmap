-- Web Push subscriptions table.
-- One row per browser per user (a user may have many devices).
-- Uniqueness enforced against 255-char prefix of the endpoint because
-- full endpoints can exceed the 3072-byte unique-key limit when the
-- column is VARCHAR(768) utf8mb4.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  endpoint VARCHAR(768) NOT NULL,
  p256dh VARCHAR(128) NOT NULL,
  auth_secret VARCHAR(64) NOT NULL,
  user_agent VARCHAR(256) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_endpoint (endpoint(255)),
  KEY k_user_id (user_id),
  CONSTRAINT fk_push_sub_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
