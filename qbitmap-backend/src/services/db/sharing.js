const ACCESS_CACHE_TTL = 60000;
const ACCESS_CACHE_MAX_SIZE = 5000;

module.exports = function(DatabaseService) {

// [PERF-10] O(K) invalidation via reverse indexes instead of O(N) scan.
DatabaseService.prototype.invalidateAccessCache = function(cameraId) {
  const keys = this._cameraAccessKeys.get(String(cameraId));
  if (!keys) return;
  for (const key of keys) this.accessCache.delete(key);
  // Clear user-side reverse entries too
  for (const key of keys) {
    const userId = key.split(':')[0];
    const userSet = this._userAccessKeys.get(userId);
    if (userSet) { userSet.delete(key); if (userSet.size === 0) this._userAccessKeys.delete(userId); }
  }
  this._cameraAccessKeys.delete(String(cameraId));
};

DatabaseService.prototype.invalidateUserAccessCache = function(userId) {
  const keys = this._userAccessKeys.get(String(userId));
  if (!keys) return;
  for (const key of keys) this.accessCache.delete(key);
  // Clear camera-side reverse entries too
  for (const key of keys) {
    const camId = key.split(':')[1];
    const camSet = this._cameraAccessKeys.get(camId);
    if (camSet) { camSet.delete(key); if (camSet.size === 0) this._cameraAccessKeys.delete(camId); }
  }
  this._userAccessKeys.delete(String(userId));
};

DatabaseService.prototype.shareCamera = async function(cameraId, ownerUserId, shareWithEmail) {
  if (!(await this.isUserCameraOwner(ownerUserId, cameraId))) {
    return { success: false, error: 'You do not own this camera' };
  }

  const targetUser = await this.getUserByEmail(shareWithEmail);
  if (!targetUser) {
    return { success: false, error: 'User not found' };
  }

  if (targetUser.id === ownerUserId) {
    return { success: false, error: 'Cannot share with yourself' };
  }

  const [existingRows] = await this.pool.execute(
    'SELECT id FROM camera_shares WHERE camera_id = ? AND shared_with_user_id = ?',
    [cameraId, targetUser.id]
  );

  if (existingRows[0]) {
    return { success: false, error: 'Already shared with this user' };
  }

  try {
    await this.pool.execute(
      'INSERT INTO camera_shares (camera_id, shared_with_user_id) VALUES (?, ?)',
      [cameraId, targetUser.id]
    );

    this.invalidateUserAccessCache(targetUser.id);

    return {
      success: true,
      share: {
        camera_id: cameraId,
        shared_with_user_id: targetUser.id,
        shared_with_email: targetUser.email,
        shared_with_name: targetUser.display_name
      }
    };
  } catch (e) {
    return { success: false, error: 'Failed to create share' };
  }
};

DatabaseService.prototype.getCameraShares = async function(cameraId) {
  const [rows] = await this.pool.execute(`
    SELECT cs.id, cs.camera_id, cs.shared_with_user_id, cs.permission, cs.created_at,
           u.email as shared_with_email, u.display_name as shared_with_name, u.avatar_url as shared_with_avatar
    FROM camera_shares cs
    JOIN users u ON u.id = cs.shared_with_user_id
    WHERE cs.camera_id = ?
    ORDER BY cs.created_at DESC
  `, [cameraId]);
  return rows;
};

DatabaseService.prototype.removeCameraShare = async function(shareId, ownerUserId) {
  const [shareRows] = await this.pool.execute('SELECT * FROM camera_shares WHERE id = ?', [shareId]);
  const share = shareRows[0];
  if (!share) {
    return { success: false, error: 'Share not found' };
  }

  if (!(await this.isUserCameraOwner(ownerUserId, share.camera_id))) {
    return { success: false, error: 'You do not own this camera' };
  }

  await this.pool.execute('DELETE FROM camera_shares WHERE id = ?', [shareId]);
  this.invalidateUserAccessCache(share.shared_with_user_id);
  return { success: true };
};

DatabaseService.prototype.getSharedCameras = async function(userId) {
  const [rows] = await this.pool.execute(`
    SELECT c.id, c.device_id, c.name, c.lng, c.lat, c.stream_mode, c.last_seen,
           c.camera_type, c.whep_url, cs.permission, cs.created_at as shared_at,
           owner.email as owner_email, owner.display_name as owner_name
    FROM camera_shares cs
    JOIN cameras c ON c.id = cs.camera_id
    JOIN users owner ON owner.id = c.user_id
    WHERE cs.shared_with_user_id = ?
    ORDER BY cs.created_at DESC
  `, [userId]);
  return rows;
};

DatabaseService.prototype.hasAccessToCamera = async function(userId, cameraIdOrDeviceId) {
  let camera;
  if (typeof cameraIdOrDeviceId === 'string') {
    camera = await this.getCameraByDeviceId(cameraIdOrDeviceId);
  } else {
    camera = await this.getCameraById(cameraIdOrDeviceId);
  }

  if (!camera) {
    return { hasAccess: false, permission: null };
  }

  const cameraId = camera.id;

  // [PERF] Check cache first
  const cacheKey = `${userId}:${cameraId}`;
  const cached = this.accessCache.get(cacheKey);
  if (cached && Date.now() - cached.time < ACCESS_CACHE_TTL) {
    return cached.result;
  }

  let result;

  if (camera.user_id === userId) {
    result = { hasAccess: true, permission: 'owner' };
  } else {
    const [shareRows] = await this.pool.execute(
      'SELECT permission FROM camera_shares WHERE camera_id = ? AND shared_with_user_id = ?',
      [cameraId, userId]
    );

    if (shareRows[0]) {
      result = { hasAccess: true, permission: shareRows[0].permission };
    } else if (camera.is_public) {
      result = { hasAccess: true, permission: 'public' };
    } else {
      result = { hasAccess: false, permission: null };
    }
  }

  // [PERF-10] Evict the oldest entry (Map insertion order = FIFO) when full.
  // The old O(N) scan for the min timestamp is replaced by a single
  // .keys().next() since Map preserves insertion order.
  if (this.accessCache.size >= ACCESS_CACHE_MAX_SIZE) {
    const oldestKey = this.accessCache.keys().next().value;
    if (oldestKey) this._removeAccessCacheKey(oldestKey);
  }
  this.accessCache.set(cacheKey, { result, time: Date.now() });
  this._addAccessCacheKey(cacheKey, userId, cameraId);

  return result;
};

DatabaseService.prototype.getUsersWithCameraAccess = async function(deviceId) {
  const camera = await this.getCameraByDeviceId(deviceId);
  if (!camera) return [];

  const [rows] = await this.pool.execute(`
    SELECT DISTINCT user_id FROM (
      SELECT user_id FROM cameras WHERE device_id = ?
      UNION
      SELECT shared_with_user_id as user_id FROM camera_shares cs
      JOIN cameras c ON cs.camera_id = c.id WHERE c.device_id = ?
    ) sub WHERE user_id IS NOT NULL
  `, [deviceId, deviceId]);
  return rows.map(r => r.user_id);
};

};
