const { notifyH3UserProfile } = require('../../utils/h3-sync');

module.exports = function(DatabaseService) {

DatabaseService.prototype.createOrUpdateUser = async function({ googleId, email, displayName, avatarUrl }) {
  const existing = await this.getUserByGoogleId(googleId);

  if (existing) {
    await this.pool.execute(
      'UPDATE users SET email = ?, display_name = ?, avatar_url = ? WHERE google_id = ?',
      [email, displayName, avatarUrl, googleId]
    );
    const user = await this.getUserByGoogleId(googleId);
    notifyH3UserProfile({ id: user.id, displayName: user.display_name, avatarUrl: user.avatar_url }).catch(() => {});
    return user;
  } else {
    await this.pool.execute(
      'INSERT INTO users (google_id, email, display_name, avatar_url) VALUES (?, ?, ?, ?)',
      [googleId, email, displayName, avatarUrl]
    );
    const user = await this.getUserByGoogleId(googleId);
    notifyH3UserProfile({ id: user.id, displayName: user.display_name, avatarUrl: user.avatar_url }).catch(() => {});
    return user;
  }
};

DatabaseService.prototype.getUserById = async function(userId) {
  const [rows] = await this.pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
  return rows[0];
};

DatabaseService.prototype.getUserByGoogleId = async function(googleId) {
  const [rows] = await this.pool.execute('SELECT * FROM users WHERE google_id = ?', [googleId]);
  return rows[0];
};

DatabaseService.prototype.getUserByEmail = async function(email) {
  const [rows] = await this.pool.execute('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0];
};

// [ARCH-04] Moved from inline db.pool.execute in routes/video-messages.js.
// Returns only the id — the caller just needs to resolve recipient for a
// private message and shouldn't receive the full user row.
DatabaseService.prototype.getActiveUserIdByEmail = async function(email) {
  const [rows] = await this.pool.execute(
    'SELECT id FROM users WHERE email = ? AND is_active = 1',
    [email]
  );
  return rows[0]?.id ?? null;
};

// [ARCH-04] H3 sync: lightweight profile list for bulk push
DatabaseService.prototype.getAllUserProfiles = async function() {
  const [rows] = await this.pool.execute(
    'SELECT id, display_name, avatar_url FROM users'
  );
  return rows;
};

DatabaseService.prototype.getUserByDisplayName = async function(displayName) {
  const [rows] = await this.pool.execute('SELECT * FROM users WHERE display_name = ?', [displayName]);
  return rows[0];
};

DatabaseService.prototype.updateUserLocation = async function(userId, lat, lng, accuracy, source) {
  await this.pool.execute(
    'UPDATE users SET last_lat = ?, last_lng = ?, last_location_accuracy = ?, last_location_source = ?, last_location_updated = NOW() WHERE id = ?',
    [lat, lng, accuracy, source || null, userId]
  );
  return this.getUserById(userId);
};

DatabaseService.prototype.updateUserLocationVisibility = async function(userId, showOnMap) {
  await this.pool.execute(
    'UPDATE users SET show_location_on_map = ? WHERE id = ?',
    [showOnMap ? 1 : 0, userId]
  );
  return this.getUserById(userId);
};

DatabaseService.prototype.getUserLocation = async function(userId) {
  const [rows] = await this.pool.execute(
    'SELECT id, last_lat, last_lng, last_location_accuracy, last_location_source, last_location_updated, show_location_on_map FROM users WHERE id = ?',
    [userId]
  );
  const user = rows[0];

  if (!user) return null;

  return {
    lat: user.last_lat,
    lng: user.last_lng,
    accuracy: user.last_location_accuracy,
    updatedAt: user.last_location_updated,
    showOnMap: !!user.show_location_on_map
  };
};

DatabaseService.prototype.getUsersWithVisibleLocation = async function() {
  const [rows] = await this.pool.execute(`
    SELECT u.id, u.display_name, u.avatar_url, u.last_lat, u.last_lng, u.last_location_accuracy, u.last_location_updated,
           (SELECT COUNT(*) FROM cameras WHERE user_id = u.id) as camera_count
    FROM users u
    WHERE u.show_location_on_map = 1 AND u.last_lat IS NOT NULL AND u.last_lng IS NOT NULL
  `);
  return rows;
};

DatabaseService.prototype.getUserCameras = async function(userId) {
  const [rows] = await this.pool.execute(`
    SELECT id, device_id, name, lng, lat, is_public, stream_mode, last_seen, created_at, camera_type, whep_url, mediamtx_path, onvif_camera_id, audio_muted
    FROM cameras
    WHERE user_id = ?
    ORDER BY last_seen DESC
  `, [userId]);
  return rows;
};

DatabaseService.prototype.updateLastLogin = async function(userId) {
  await this.pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [userId]);
};

DatabaseService.prototype.updateUserPlan = async function(userId, planId) {
  await this.pool.execute('UPDATE users SET plan_id = ? WHERE id = ?', [planId, userId]);
  return this.getUserById(userId);
};

DatabaseService.prototype.updateUserRole = async function(userId, role) {
  if (!['user', 'admin'].includes(role)) {
    return { success: false, error: 'Invalid role' };
  }
  // [ARCH-02] Bump token_version alongside role change so the old JWT
  // (which carries the previous role claim) is revoked. The user must
  // re-login and receives a fresh JWT with the new role embedded.
  await this.pool.execute(
    'UPDATE users SET role = ?, token_version = token_version + 1 WHERE id = ?',
    [role, userId]
  );
  return { success: true };
};

DatabaseService.prototype.setUserActive = async function(userId, isActive) {
  // [SEC-01] Deactivation must immediately revoke outstanding JWTs. Bump
  // token_version in the same statement so in-flight tokens fail the version
  // check inside authHook within its short version-cache TTL.
  if (isActive) {
    await this.pool.execute('UPDATE users SET is_active = 1 WHERE id = ?', [userId]);
  } else {
    await this.pool.execute(
      'UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?',
      [userId]
    );
  }
  return { success: true };
};

// [SEC-01] Bump token_version to revoke all outstanding JWTs for this user.
// Called on logout so a leaked/shared token cannot outlive the session.
DatabaseService.prototype.bumpUserTokenVersion = async function(userId) {
  await this.pool.execute(
    'UPDATE users SET token_version = token_version + 1 WHERE id = ?',
    [userId]
  );
};

DatabaseService.prototype.setUserOverrides = async function(userId, overrides) {
  const [existingRows] = await this.pool.execute(
    'SELECT id FROM user_feature_overrides WHERE user_id = ?',
    [userId]
  );
  const existing = existingRows[0];

  const columns = [
    'max_cameras', 'max_whep_cameras', 'ai_analysis_enabled', 'ai_daily_limit',
    'face_recognition_enabled', 'max_faces_per_camera', 'recording_enabled',
    'max_recording_hours', 'recording_retention_days', 'voice_call_enabled',
    'face_login_enabled', 'voice_control_enabled', 'public_sharing_enabled', 'notes'
  ];

  if (existing) {
    const updates = [];
    const values = [];

    columns.forEach(col => {
      if (overrides.hasOwnProperty(col)) {
        updates.push(`${col} = ?`);
        values.push(overrides[col]);
      }
    });

    if (updates.length > 0) {
      updates.push('updated_at = NOW()');
      values.push(userId);
      await this.pool.execute(
        `UPDATE user_feature_overrides SET ${updates.join(', ')} WHERE user_id = ?`,
        values
      );
    }
  } else {
    const cols = ['user_id'];
    const vals = [userId];
    const placeholders = ['?'];

    columns.forEach(col => {
      if (overrides.hasOwnProperty(col)) {
        cols.push(col);
        vals.push(overrides[col]);
        placeholders.push('?');
      }
    });

    await this.pool.execute(
      `INSERT INTO user_feature_overrides (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
      vals
    );
  }

  return { success: true };
};

DatabaseService.prototype.clearUserOverrides = async function(userId) {
  await this.pool.execute('DELETE FROM user_feature_overrides WHERE user_id = ?', [userId]);
  return { success: true };
};

DatabaseService.prototype.getUserOverrides = async function(userId) {
  const [rows] = await this.pool.execute('SELECT * FROM user_feature_overrides WHERE user_id = ?', [userId]);
  return rows[0];
};

DatabaseService.prototype.searchUsersByName = async function(query, limit = 10) {
  const safeLimit = Math.min(parseInt(limit) || 10, 20);
  const [rows] = await this.pool.execute(
    `SELECT id, display_name, email, avatar_url FROM users
     WHERE is_active = 1 AND (display_name LIKE ? OR email LIKE ?)
     ORDER BY display_name
     LIMIT ${safeLimit}`,
    [`%${query}%`, `%${query}%`]
  );
  return rows;
};

DatabaseService.prototype.getUserRecentMessages = async function(userId, limit = 5) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || 5, 1), 20);
  const [rows] = await this.pool.execute(
    `SELECT message_id, media_type, thumbnail_path, description, duration_ms, created_at
     FROM video_messages
     WHERE sender_id = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit}`,
    [userId]
  );
  return rows;
};

DatabaseService.prototype.getSharedCameraCount = async function(userId) {
  const [rows] = await this.pool.execute(
    'SELECT COUNT(*) as count FROM camera_shares WHERE shared_with_user_id = ?',
    [userId]
  );
  return rows[0].count;
};

DatabaseService.prototype.getUserMessageCount = async function(userId) {
  const [rows] = await this.pool.execute(
    'SELECT COUNT(*) as count FROM video_messages WHERE sender_id = ?',
    [userId]
  );
  return rows[0].count;
};

};
