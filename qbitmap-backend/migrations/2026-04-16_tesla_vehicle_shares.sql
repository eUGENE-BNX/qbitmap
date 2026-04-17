CREATE TABLE IF NOT EXISTS tesla_vehicle_shares (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tesla_vehicle_id INT UNSIGNED NOT NULL,
  shared_with_user_id INT UNSIGNED NOT NULL,
  proximity_alert_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tesla_share (tesla_vehicle_id, shared_with_user_id),
  INDEX idx_share_user (shared_with_user_id),
  CONSTRAINT fk_tesla_share_vehicle FOREIGN KEY (tesla_vehicle_id) REFERENCES tesla_vehicles(id) ON DELETE CASCADE,
  CONSTRAINT fk_tesla_share_user FOREIGN KEY (shared_with_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
