CREATE TABLE IF NOT EXISTS tesla_vehicle_photos (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tesla_vehicle_id INT UNSIGNED NOT NULL,
  slot_index TINYINT UNSIGNED NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  width SMALLINT UNSIGNED NOT NULL,
  height SMALLINT UNSIGNED NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  ai_confidence DECIMAL(4,3) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_vehicle_slot (tesla_vehicle_id, slot_index),
  CONSTRAINT fk_tvp_vehicle FOREIGN KEY (tesla_vehicle_id) REFERENCES tesla_vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
