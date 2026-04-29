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

DatabaseService.prototype.upsertTeslaVehicle = async function({ teslaAccountId, vehicleId, vin, displayName, model, carType, color, wheelType, trimBadging, carVersion, odometer }) {
  await this.pool.execute(
    `INSERT INTO tesla_vehicles (tesla_account_id, vehicle_id, vin, display_name, model, car_type, color, wheel_type, trim_badging, car_version, odometer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), model = VALUES(model),
       car_type = COALESCE(VALUES(car_type), car_type), color = COALESCE(VALUES(color), color),
       wheel_type = COALESCE(VALUES(wheel_type), wheel_type),
       trim_badging = COALESCE(VALUES(trim_badging), trim_badging),
       car_version = COALESCE(VALUES(car_version), car_version),
       odometer = COALESCE(VALUES(odometer), odometer), updated_at = NOW()`,
    [teslaAccountId, vehicleId, vin, displayName ?? vin, model ?? null, carType ?? null, color ?? null, wheelType ?? null, trimBadging ?? null, carVersion ?? null, odometer ?? null]
  );
};

DatabaseService.prototype.updateVehicleTelemetry = async function({ vin, lat, lng, soc, gear, bearing, speed, insideTemp, outsideTemp, estRange, chargeLimit, locked, sentry, odometer, tpmsFl, tpmsFr, tpmsRl, tpmsRr }) {
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
  if (odometer != null) { fields.push('odometer = ?'); values.push(odometer); }
  if (tpmsFl != null) { fields.push('last_tpms_fl = ?'); values.push(tpmsFl); }
  if (tpmsFr != null) { fields.push('last_tpms_fr = ?'); values.push(tpmsFr); }
  if (tpmsRl != null) { fields.push('last_tpms_rl = ?'); values.push(tpmsRl); }
  if (tpmsRr != null) { fields.push('last_tpms_rr = ?'); values.push(tpmsRr); }
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
    `SELECT v.*, a.full_name AS owner_name, a.profile_image_url AS owner_profile_image,
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

DatabaseService.prototype.getMeshVisibleTeslaVehicles = async function() {
  const [rows] = await this.pool.execute(
    `SELECT v.*, a.user_id, a.full_name AS owner_full_name, a.profile_image_url AS owner_profile_image,
            u.display_name, u.avatar_url
     FROM tesla_vehicles v
     JOIN tesla_accounts a ON a.id = v.tesla_account_id
     JOIN users u ON u.id = a.user_id
     WHERE v.mesh_visible = 1`
  );
  return rows;
};

DatabaseService.prototype.setTeslaVehicleMeshVisible = async function(vehicleId, userId, visible) {
  const [res] = await this.pool.execute(
    `UPDATE tesla_vehicles v
     JOIN tesla_accounts a ON a.id = v.tesla_account_id
     SET v.mesh_visible = ?, v.updated_at = NOW()
     WHERE v.vehicle_id = ? AND a.user_id = ?`,
    [visible ? 1 : 0, vehicleId, userId]
  );
  return res.affectedRows > 0;
};

DatabaseService.prototype.setTeslaVehicleOffline = async function(vin) {
  await this.pool.execute('UPDATE tesla_vehicles SET is_online = 0, updated_at = NOW() WHERE vin = ?', [vin]);
};

DatabaseService.prototype.setTeslaVehicleTelemetryEnabled = async function(vehicleId, enabled) {
  await this.pool.execute('UPDATE tesla_vehicles SET telemetry_enabled = ?, updated_at = NOW() WHERE vehicle_id = ?', [enabled ? 1 : 0, vehicleId]);
};

DatabaseService.prototype.updateTeslaVehicleLicensePlate = async function(vehicleId, userId, licensePlate) {
  await this.pool.execute(
    `UPDATE tesla_vehicles v
     JOIN tesla_accounts a ON a.id = v.tesla_account_id
     SET v.license_plate = ?, v.updated_at = NOW()
     WHERE v.vehicle_id = ? AND a.user_id = ?`,
    [licensePlate, vehicleId, userId]
  );
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

// Tesla-share ownership guard. Vehicle endpoints accept the external
// tesla_vehicle_id (string) but FKs need the internal PK (int) — this
// resolves one to the other while also verifying the caller owns it.
DatabaseService.prototype.getOwnedTeslaVehiclePk = async function(vehicleId, ownerUserId) {
  const [rows] = await this.pool.execute(
    `SELECT v.id FROM tesla_vehicles v
     JOIN tesla_accounts a ON a.id = v.tesla_account_id
     WHERE v.vehicle_id = ? AND a.user_id = ?`,
    [vehicleId, ownerUserId]
  );
  return rows[0]?.id || null;
};

DatabaseService.prototype.shareTeslaVehicle = async function(vehicleId, ownerUserId, shareWithEmail) {
  const pk = await this.getOwnedTeslaVehiclePk(vehicleId, ownerUserId);
  if (!pk) return { success: false, error: 'You do not own this vehicle' };

  const targetUser = await this.getUserByEmail(shareWithEmail);
  if (!targetUser) return { success: false, error: 'User not found' };
  if (targetUser.id === ownerUserId) return { success: false, error: 'Cannot share with yourself' };

  try {
    await this.pool.execute(
      `INSERT INTO tesla_vehicle_shares (tesla_vehicle_id, shared_with_user_id)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE shared_with_user_id = VALUES(shared_with_user_id)`,
      [pk, targetUser.id]
    );
    return {
      success: true,
      share: {
        userId: targetUser.id,
        email: targetUser.email,
        displayName: targetUser.display_name,
        avatarUrl: targetUser.avatar_url,
        proximityAlertEnabled: true,
      },
    };
  } catch {
    return { success: false, error: 'Failed to create share' };
  }
};

DatabaseService.prototype.unshareTeslaVehicle = async function(vehicleId, ownerUserId, sharedUserId) {
  const pk = await this.getOwnedTeslaVehiclePk(vehicleId, ownerUserId);
  if (!pk) return { success: false, error: 'You do not own this vehicle' };
  await this.pool.execute(
    'DELETE FROM tesla_vehicle_shares WHERE tesla_vehicle_id = ? AND shared_with_user_id = ?',
    [pk, sharedUserId]
  );
  return { success: true };
};

DatabaseService.prototype.setTeslaShareProximityAlert = async function(vehicleId, ownerUserId, sharedUserId, enabled) {
  const pk = await this.getOwnedTeslaVehiclePk(vehicleId, ownerUserId);
  if (!pk) return { success: false, error: 'You do not own this vehicle' };
  const [res] = await this.pool.execute(
    'UPDATE tesla_vehicle_shares SET proximity_alert_enabled = ? WHERE tesla_vehicle_id = ? AND shared_with_user_id = ?',
    [enabled ? 1 : 0, pk, sharedUserId]
  );
  return { success: res.affectedRows > 0 };
};

DatabaseService.prototype.getTeslaVehicleShares = async function(vehicleId, ownerUserId) {
  const pk = await this.getOwnedTeslaVehiclePk(vehicleId, ownerUserId);
  if (!pk) return null;
  const [rows] = await this.pool.execute(
    `SELECT s.shared_with_user_id, s.proximity_alert_enabled, s.created_at,
            u.email, u.display_name, u.avatar_url
     FROM tesla_vehicle_shares s
     JOIN users u ON u.id = s.shared_with_user_id
     WHERE s.tesla_vehicle_id = ?
     ORDER BY s.created_at DESC`,
    [pk]
  );
  return rows.map(r => ({
    userId: r.shared_with_user_id,
    email: r.email,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    proximityAlertEnabled: !!r.proximity_alert_enabled,
    createdAt: r.created_at,
  }));
};

// Returns vehicles the given user has either mesh-visible access to, owns,
// or has been individually shared. Used to build a per-user mesh snapshot
// (so a hidden vehicle still shows to its owner and to anyone on its share list).
DatabaseService.prototype.getTeslaVehiclesVisibleToUser = async function(userId) {
  const [rows] = await this.pool.execute(
    `SELECT v.*, a.user_id, a.full_name AS owner_full_name, a.profile_image_url AS owner_profile_image,
            u.display_name, u.avatar_url
     FROM tesla_vehicles v
     JOIN tesla_accounts a ON a.id = v.tesla_account_id
     JOIN users u ON u.id = a.user_id
     WHERE v.mesh_visible = 1
        OR a.user_id = ?
        OR EXISTS (
             SELECT 1 FROM tesla_vehicle_shares s
             WHERE s.tesla_vehicle_id = v.id AND s.shared_with_user_id = ?
           )`,
    [userId, userId]
  );
  return rows;
};

// Returns the set of user IDs who should receive a given vehicle's telemetry:
// the owner + every user it's shared with. Everyone-else visibility
// (mesh_visible=1) is handled separately by the broadcast function.
DatabaseService.prototype.getTeslaVehiclePrivateAudience = async function(vehicleInternalId) {
  const [rows] = await this.pool.execute(
    `SELECT a.user_id FROM tesla_vehicles v
     JOIN tesla_accounts a ON a.id = v.tesla_account_id
     WHERE v.id = ?
     UNION
     SELECT s.shared_with_user_id AS user_id
     FROM tesla_vehicle_shares s
     WHERE s.tesla_vehicle_id = ?`,
    [vehicleInternalId, vehicleInternalId]
  );
  return rows.map(r => r.user_id);
};

// For proximity checks: returns every peer Tesla vehicle (with location)
// belonging to a user with whom movingUserId has an active, proximity-enabled
// share — in either direction. The caller computes distance and decides
// whether to alert.
DatabaseService.prototype.getTeslaProximityPeers = async function(movingUserId) {
  const [rows] = await this.pool.execute(
    `SELECT v.id AS vehicle_pk, v.vin, v.display_name, v.last_lat, v.last_lng,
            v.last_telemetry_at, a.user_id AS peer_user_id,
            u.display_name AS peer_name, u.avatar_url AS peer_avatar
     FROM tesla_vehicles v
     JOIN tesla_accounts a ON a.id = v.tesla_account_id
     JOIN users u ON u.id = a.user_id
     WHERE a.user_id != ?
       AND v.last_lat IS NOT NULL
       AND v.last_lng IS NOT NULL
       AND a.user_id IN (
         SELECT s1.shared_with_user_id
         FROM tesla_vehicle_shares s1
         JOIN tesla_vehicles v1 ON v1.id = s1.tesla_vehicle_id
         JOIN tesla_accounts a1 ON a1.id = v1.tesla_account_id
         WHERE a1.user_id = ? AND s1.proximity_alert_enabled = 1
         UNION
         SELECT a2.user_id
         FROM tesla_vehicle_shares s2
         JOIN tesla_vehicles v2 ON v2.id = s2.tesla_vehicle_id
         JOIN tesla_accounts a2 ON a2.id = v2.tesla_account_id
         WHERE s2.shared_with_user_id = ? AND s2.proximity_alert_enabled = 1
       )`,
    [movingUserId, movingUserId, movingUserId]
  );
  return rows;
};

};
