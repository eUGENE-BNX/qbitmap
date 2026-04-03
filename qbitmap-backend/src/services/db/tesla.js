module.exports = function(DatabaseService) {

DatabaseService.prototype.getTeslaAccountByUserId = async function(userId) {
  const [rows] = await this.pool.execute('SELECT * FROM tesla_accounts WHERE user_id = ?', [userId]);
  return rows[0] || null;
};

DatabaseService.prototype.createOrUpdateTeslaAccount = async function({ userId, teslaUserId, email, fullName, profileImageUrl }) {
  // MySQL2 does not accept undefined — coerce to null
  const _email = email ?? null;
  const _fullName = fullName ?? null;
  const _profileImageUrl = profileImageUrl ?? null;

  const existing = await this.getTeslaAccountByUserId(userId);
  if (existing) {
    await this.pool.execute(
      'UPDATE tesla_accounts SET tesla_user_id = ?, email = ?, full_name = ?, profile_image_url = ?, updated_at = NOW() WHERE user_id = ?',
      [teslaUserId, _email, _fullName, _profileImageUrl, userId]
    );
    return this.getTeslaAccountByUserId(userId);
  }
  await this.pool.execute(
    'INSERT INTO tesla_accounts (user_id, tesla_user_id, email, full_name, profile_image_url) VALUES (?, ?, ?, ?, ?)',
    [userId, teslaUserId, _email, _fullName, _profileImageUrl]
  );
  return this.getTeslaAccountByUserId(userId);
};

DatabaseService.prototype.deleteTeslaAccount = async function(userId) {
  await this.pool.execute('DELETE FROM tesla_accounts WHERE user_id = ?', [userId]);
};

DatabaseService.prototype.saveTeslaTokens = async function({ teslaAccountId, accessToken, refreshToken, expiresAt, scopes }) {
  await this.pool.execute(
    `INSERT INTO tesla_tokens (tesla_account_id, access_token, refresh_token, expires_at, scopes)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE access_token = VALUES(access_token), refresh_token = VALUES(refresh_token),
       expires_at = VALUES(expires_at), scopes = VALUES(scopes), updated_at = NOW()`,
    [teslaAccountId, accessToken, refreshToken, expiresAt, scopes]
  );
};

DatabaseService.prototype.getTeslaTokensByUserId = async function(userId) {
  const [rows] = await this.pool.execute(
    `SELECT t.* FROM tesla_tokens t
     JOIN tesla_accounts a ON a.id = t.tesla_account_id
     WHERE a.user_id = ?`,
    [userId]
  );
  return rows[0] || null;
};

DatabaseService.prototype.getTeslaTokensByAccountId = async function(teslaAccountId) {
  const [rows] = await this.pool.execute('SELECT * FROM tesla_tokens WHERE tesla_account_id = ?', [teslaAccountId]);
  return rows[0] || null;
};

DatabaseService.prototype.getExpiringTeslaTokens = async function(minutesBefore = 30) {
  const [rows] = await this.pool.execute(
    `SELECT t.*, a.user_id FROM tesla_tokens t
     JOIN tesla_accounts a ON a.id = t.tesla_account_id
     WHERE t.expires_at <= DATE_ADD(NOW(), INTERVAL ? MINUTE)`,
    [minutesBefore]
  );
  return rows;
};

DatabaseService.prototype.upsertTeslaVehicle = async function({ teslaAccountId, vehicleId, vin, displayName, model, color }) {
  await this.pool.execute(
    `INSERT INTO tesla_vehicles (tesla_account_id, vehicle_id, vin, display_name, model, color)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), model = VALUES(model),
       color = VALUES(color), updated_at = NOW()`,
    [teslaAccountId, vehicleId, vin, displayName ?? vin, model ?? null, color ?? null]
  );
};

DatabaseService.prototype.updateVehicleTelemetry = async function({ vin, lat, lng, soc, gear, bearing, speed, insideTemp, outsideTemp, estRange, chargeLimit, locked, sentry }) {
  const fields = [];
  const values = [];
  if (lat != null) { fields.push('last_lat = ?'); values.push(lat); }
  if (lng != null) { fields.push('last_lng = ?'); values.push(lng); }
  if (soc != null) { fields.push('last_soc = ?'); values.push(soc); }
  if (gear != null) { fields.push('last_gear = ?'); values.push(gear); }
  if (bearing != null) { fields.push('last_bearing = ?'); values.push(bearing); }
  if (speed != null) { fields.push('last_speed = ?'); values.push(speed); }
  if (insideTemp != null) { fields.push('last_inside_temp = ?'); values.push(insideTemp); }
  if (outsideTemp != null) { fields.push('last_outside_temp = ?'); values.push(outsideTemp); }
  if (estRange != null) { fields.push('last_est_range = ?'); values.push(estRange); }
  if (chargeLimit != null) { fields.push('last_charge_limit = ?'); values.push(chargeLimit); }
  if (locked != null) { fields.push('last_locked = ?'); values.push(locked); }
  if (sentry != null) { fields.push('last_sentry = ?'); values.push(sentry); }
  if (fields.length === 0) return;

  fields.push('last_telemetry_at = NOW()', 'is_online = 1', 'updated_at = NOW()');
  values.push(vin);

  await this.pool.execute(
    `UPDATE tesla_vehicles SET ${fields.join(', ')} WHERE vin = ?`,
    values
  );
};

DatabaseService.prototype.getTeslaVehiclesByUserId = async function(userId) {
  const [rows] = await this.pool.execute(
    `SELECT v.*, a.full_name AS owner_name, a.profile_image_url AS owner_avatar,
            u.display_name, u.avatar_url
     FROM tesla_vehicles v
     JOIN tesla_accounts a ON a.id = v.tesla_account_id
     JOIN users u ON u.id = a.user_id
     WHERE a.user_id = ?`,
    [userId]
  );
  return rows;
};

DatabaseService.prototype.getTeslaVehicleByVin = async function(vin) {
  const [rows] = await this.pool.execute(
    `SELECT v.*, a.user_id FROM tesla_vehicles v
     JOIN tesla_accounts a ON a.id = v.tesla_account_id
     WHERE v.vin = ?`,
    [vin]
  );
  return rows[0] || null;
};

DatabaseService.prototype.getAllOnlineTeslaVehicles = async function() {
  const [rows] = await this.pool.execute(
    `SELECT v.*, a.full_name AS owner_name, a.profile_image_url AS owner_avatar,
            a.user_id, u.display_name, u.avatar_url
     FROM tesla_vehicles v
     JOIN tesla_accounts a ON a.id = v.tesla_account_id
     JOIN users u ON u.id = a.user_id
     WHERE v.is_online = 1 AND v.last_lat IS NOT NULL AND v.last_lng IS NOT NULL`
  );
  return rows;
};

DatabaseService.prototype.setTeslaVehicleOffline = async function(vin) {
  await this.pool.execute('UPDATE tesla_vehicles SET is_online = 0, updated_at = NOW() WHERE vin = ?', [vin]);
};

DatabaseService.prototype.setTeslaVehicleTelemetryEnabled = async function(vehicleId, enabled) {
  await this.pool.execute('UPDATE tesla_vehicles SET telemetry_enabled = ?, updated_at = NOW() WHERE vehicle_id = ?', [enabled ? 1 : 0, vehicleId]);
};

DatabaseService.prototype.getTeslaVehicleByVehicleId = async function(vehicleId) {
  const [rows] = await this.pool.execute(
    `SELECT v.*, a.user_id FROM tesla_vehicles v
     JOIN tesla_accounts a ON a.id = v.tesla_account_id
     WHERE v.vehicle_id = ?`,
    [vehicleId]
  );
  return rows[0] || null;
};

};
