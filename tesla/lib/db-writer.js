const mysql = require('mysql2/promise');
const config = require('../config');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(config.db);
  }
  return pool;
}

async function dbWriter(update) {
  const { vin, lat, lng, soc, gear, bearing, speed } = update;
  const p = getPool();

  const fields = [];
  const values = [];

  if (lat != null) { fields.push('last_lat = ?'); values.push(lat); }
  if (lng != null) { fields.push('last_lng = ?'); values.push(lng); }
  if (soc != null) { fields.push('last_soc = ?'); values.push(soc); }
  if (gear != null) { fields.push('last_gear = ?'); values.push(gear); }
  if (bearing != null) { fields.push('last_bearing = ?'); values.push(bearing); }
  if (speed != null) { fields.push('last_speed = ?'); values.push(speed); }

  if (fields.length === 0) return;

  fields.push('last_telemetry_at = NOW()', 'is_online = 1', 'updated_at = NOW()');
  values.push(vin);

  await p.execute(
    `UPDATE tesla_vehicles SET ${fields.join(', ')} WHERE vin = ?`,
    values
  );
}

module.exports = { dbWriter };
