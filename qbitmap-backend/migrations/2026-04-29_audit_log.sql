CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ts TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
  user_id INT NULL,
  ip VARCHAR(45) NULL,
  ua VARCHAR(255) NULL,
  method VARCHAR(8) NOT NULL,
  path VARCHAR(255) NOT NULL,
  action VARCHAR(64) NOT NULL,
  target VARCHAR(255) NULL,
  success TINYINT NOT NULL DEFAULT 0,
  status_code SMALLINT NOT NULL,
  payload_hash VARCHAR(64) NULL,
  INDEX idx_user_ts (user_id, ts),
  INDEX idx_action_ts (action, ts),
  INDEX idx_ts (ts)
);
