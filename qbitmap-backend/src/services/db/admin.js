module.exports = function(DatabaseService) {

DatabaseService.prototype.seedUserPlans = async function() {
  const plans = [
    { name: 'free', display_name: 'Free', max_cameras: 2, max_whep_cameras: 1, ai_analysis_enabled: 0, ai_daily_limit: 0, face_recognition_enabled: 0, max_faces_per_camera: 0, recording_enabled: 0, max_recording_hours: 0, recording_retention_days: 7, voice_call_enabled: 0, face_login_enabled: 0, voice_control_enabled: 0, public_sharing_enabled: 0, priority_support: 0 },
    { name: 'basic', display_name: 'Basic', max_cameras: 5, max_whep_cameras: 2, ai_analysis_enabled: 1, ai_daily_limit: 10, face_recognition_enabled: 1, max_faces_per_camera: 5, recording_enabled: 1, max_recording_hours: 5, recording_retention_days: 7, voice_call_enabled: 0, face_login_enabled: 0, voice_control_enabled: 0, public_sharing_enabled: 0, priority_support: 0 },
    { name: 'pro', display_name: 'Pro', max_cameras: 15, max_whep_cameras: 5, ai_analysis_enabled: 1, ai_daily_limit: 100, face_recognition_enabled: 1, max_faces_per_camera: 20, recording_enabled: 1, max_recording_hours: 50, recording_retention_days: 30, voice_call_enabled: 1, face_login_enabled: 1, voice_control_enabled: 1, public_sharing_enabled: 1, priority_support: 0 },
    { name: 'enterprise', display_name: 'Enterprise', max_cameras: -1, max_whep_cameras: -1, ai_analysis_enabled: 1, ai_daily_limit: -1, face_recognition_enabled: 1, max_faces_per_camera: -1, recording_enabled: 1, max_recording_hours: -1, recording_retention_days: 90, voice_call_enabled: 1, face_login_enabled: 1, voice_control_enabled: 1, public_sharing_enabled: 1, priority_support: 1 }
  ];

  const columns = Object.keys(plans[0]);
  const placeholders = columns.map(() => '?').join(', ');

  for (const plan of plans) {
    try {
      await this.pool.execute(
        `INSERT IGNORE INTO user_plans (${columns.join(', ')}) VALUES (${placeholders})`,
        columns.map(c => plan[c])
      );
    } catch (e) {
      // Plan already exists
    }
  }
};

DatabaseService.prototype.setAdminUser = async function() {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  for (const email of adminEmails) {
    try {
      await this.pool.execute(
        "UPDATE users SET role = 'admin' WHERE email = ? AND (role IS NULL OR role = 'user')",
        [email]
      );
    } catch (e) {
      // User might not exist yet
    }
  }
};

DatabaseService.prototype.getAllPlans = async function() {
  const [rows] = await this.pool.execute('SELECT * FROM user_plans ORDER BY id');
  return rows;
};

DatabaseService.prototype.getPlanById = async function(planId) {
  const [rows] = await this.pool.execute('SELECT * FROM user_plans WHERE id = ?', [planId]);
  return rows[0];
};

DatabaseService.prototype.getPlanByName = async function(name) {
  const [rows] = await this.pool.execute('SELECT * FROM user_plans WHERE name = ?', [name]);
  return rows[0];
};

DatabaseService.prototype.getUserEffectiveLimits = async function(userId) {
  // [PERF] Single JOIN query instead of 3 sequential queries
  const [rows] = await this.pool.execute(`
    SELECT u.id, u.plan_id, u.role, u.is_active, u.google_id, u.email, u.display_name, u.avatar_url,
           u.face_api_person_id, u.created_at, u.last_login,
           p.name as p_name, p.display_name as p_display_name,
           p.max_cameras as p_max_cameras, p.max_whep_cameras as p_max_whep_cameras,
           p.ai_analysis_enabled as p_ai_analysis_enabled, p.ai_daily_limit as p_ai_daily_limit,
           p.face_recognition_enabled as p_face_recognition_enabled, p.max_faces_per_camera as p_max_faces_per_camera,
           p.recording_enabled as p_recording_enabled, p.max_recording_hours as p_max_recording_hours,
           p.recording_retention_days as p_recording_retention_days, p.voice_call_enabled as p_voice_call_enabled,
           p.face_login_enabled as p_face_login_enabled, p.voice_control_enabled as p_voice_control_enabled,
           p.public_sharing_enabled as p_public_sharing_enabled, p.priority_support as p_priority_support,
           o.max_cameras as o_max_cameras, o.max_whep_cameras as o_max_whep_cameras,
           o.ai_analysis_enabled as o_ai_analysis_enabled, o.ai_daily_limit as o_ai_daily_limit,
           o.face_recognition_enabled as o_face_recognition_enabled, o.max_faces_per_camera as o_max_faces_per_camera,
           o.recording_enabled as o_recording_enabled, o.max_recording_hours as o_max_recording_hours,
           o.recording_retention_days as o_recording_retention_days, o.voice_call_enabled as o_voice_call_enabled,
           o.face_login_enabled as o_face_login_enabled, o.voice_control_enabled as o_voice_control_enabled,
           o.public_sharing_enabled as o_public_sharing_enabled,
           o.id as o_id
    FROM users u
    LEFT JOIN user_plans p ON p.id = COALESCE(u.plan_id, 1)
    LEFT JOIN user_feature_overrides o ON o.user_id = u.id
    WHERE u.id = ?
  `, [userId]);

  const row = rows[0];
  if (!row) return null;

  const user = row;
  const plan = { name: row.p_name, display_name: row.p_display_name };
  const override = row.o_id ? row : null;

  const limits = {
    plan_id: user.plan_id || 1,
    plan_name: plan.name,
    plan_display_name: plan.display_name,
    role: user.role || 'user',
    is_active: user.is_active !== 0,
    max_cameras: override?.o_max_cameras ?? row.p_max_cameras,
    max_whep_cameras: override?.o_max_whep_cameras ?? row.p_max_whep_cameras,
    ai_analysis_enabled: override?.o_ai_analysis_enabled ?? row.p_ai_analysis_enabled,
    ai_daily_limit: override?.o_ai_daily_limit ?? row.p_ai_daily_limit,
    face_recognition_enabled: override?.o_face_recognition_enabled ?? row.p_face_recognition_enabled,
    max_faces_per_camera: override?.o_max_faces_per_camera ?? row.p_max_faces_per_camera,
    recording_enabled: override?.o_recording_enabled ?? row.p_recording_enabled,
    max_recording_hours: override?.o_max_recording_hours ?? row.p_max_recording_hours,
    recording_retention_days: override?.o_recording_retention_days ?? row.p_recording_retention_days,
    voice_call_enabled: override?.o_voice_call_enabled ?? row.p_voice_call_enabled,
    face_login_enabled: override?.o_face_login_enabled ?? row.p_face_login_enabled,
    voice_control_enabled: override?.o_voice_control_enabled ?? row.p_voice_control_enabled,
    public_sharing_enabled: override?.o_public_sharing_enabled ?? row.p_public_sharing_enabled,
    priority_support: row.p_priority_support,
    has_override: !!override
  };

  Object.keys(limits).forEach(key => {
    if (key.endsWith('_enabled') || key === 'priority_support') {
      limits[key] = !!limits[key];
    }
  });

  return limits;
};

DatabaseService.prototype.getUserTodayUsage = async function(userId) {
  const today = new Date().toISOString().split('T')[0];
  const [rows] = await this.pool.execute(
    'SELECT * FROM user_usage WHERE user_id = ? AND usage_date = ?',
    [userId, today]
  );

  if (!rows[0]) {
    await this.pool.execute(
      'INSERT INTO user_usage (user_id, usage_date) VALUES (?, ?)',
      [userId, today]
    );
    return { ai_analysis_count: 0, face_recognition_count: 0, recording_minutes: 0, voice_call_count: 0 };
  }

  return rows[0];
};

DatabaseService.prototype.incrementUsage = async function(userId, feature, amount = 1) {
  const today = new Date().toISOString().split('T')[0];

  await this.getUserTodayUsage(userId);

  const columnMap = {
    ai_analysis: 'ai_analysis_count',
    face_recognition: 'face_recognition_count',
    recording: 'recording_minutes',
    voice_call: 'voice_call_count'
  };

  const column = columnMap[feature];
  if (!column) return false;

  await this.pool.execute(
    `UPDATE user_usage SET ${column} = ${column} + ? WHERE user_id = ? AND usage_date = ?`,
    [amount, userId, today]
  );

  return true;
};

DatabaseService.prototype.checkFeatureLimit = async function(userId, feature) {
  const limits = await this.getUserEffectiveLimits(userId);
  if (!limits) return { allowed: false, reason: 'User not found' };
  if (!limits.is_active) return { allowed: false, reason: 'Account deactivated' };

  const usage = await this.getUserTodayUsage(userId);

  switch (feature) {
    case 'cameras': {
      const [rows] = await this.pool.execute(
        "SELECT COUNT(*) as count FROM cameras WHERE user_id = ? AND camera_type = 'device'",
        [userId]
      );
      const currentCameras = rows[0].count;

      if (limits.max_cameras === -1) return { allowed: true };
      return {
        allowed: currentCameras < limits.max_cameras,
        current: currentCameras,
        limit: limits.max_cameras,
        reason: currentCameras >= limits.max_cameras ? 'Camera limit reached' : null
      };
    }

    case 'whep_cameras': {
      const [rows] = await this.pool.execute(
        "SELECT COUNT(*) as count FROM cameras WHERE user_id = ? AND camera_type = 'whep'",
        [userId]
      );
      const currentWhep = rows[0].count;

      if (limits.max_whep_cameras === -1) return { allowed: true };
      return {
        allowed: currentWhep < limits.max_whep_cameras,
        current: currentWhep,
        limit: limits.max_whep_cameras,
        reason: currentWhep >= limits.max_whep_cameras ? 'WHEP camera limit reached' : null
      };
    }

    case 'ai_analysis': {
      if (!limits.ai_analysis_enabled) {
        return { allowed: false, reason: 'AI analysis not enabled for your plan' };
      }
      if (limits.ai_daily_limit === -1) return { allowed: true };
      return {
        allowed: usage.ai_analysis_count < limits.ai_daily_limit,
        current: usage.ai_analysis_count,
        limit: limits.ai_daily_limit,
        reason: usage.ai_analysis_count >= limits.ai_daily_limit ? 'Daily AI limit reached' : null
      };
    }

    case 'face_recognition': {
      if (!limits.face_recognition_enabled) {
        return { allowed: false, reason: 'Face recognition not enabled for your plan' };
      }
      return { allowed: true };
    }

    case 'recording': {
      if (!limits.recording_enabled) {
        return { allowed: false, reason: 'Recording not enabled for your plan' };
      }
      if (limits.max_recording_hours === -1) return { allowed: true };
      const maxMinutes = limits.max_recording_hours * 60;
      return {
        allowed: usage.recording_minutes < maxMinutes,
        current: usage.recording_minutes,
        limit: maxMinutes,
        reason: usage.recording_minutes >= maxMinutes ? 'Monthly recording limit reached' : null
      };
    }

    case 'voice_call': {
      if (!limits.voice_call_enabled) {
        return { allowed: false, reason: 'Voice call not enabled for your plan' };
      }
      return { allowed: true };
    }

    case 'face_login':
      return { allowed: limits.face_login_enabled, reason: !limits.face_login_enabled ? 'FaceID login not enabled for your plan' : null };

    case 'voice_control':
      return { allowed: limits.voice_control_enabled, reason: !limits.voice_control_enabled ? 'Voice control not enabled for your plan' : null };

    case 'public_sharing':
      return { allowed: limits.public_sharing_enabled, reason: !limits.public_sharing_enabled ? 'Public sharing not enabled for your plan' : null };

    default:
      return { allowed: false, reason: 'Unknown feature' };
  }
};

DatabaseService.prototype.checkFaceLimit = async function(userId, cameraId) {
  const limits = await this.getUserEffectiveLimits(userId);
  if (!limits) return { allowed: false, reason: 'User not found' };
  if (!limits.face_recognition_enabled) {
    return { allowed: false, reason: 'Face recognition not enabled for your plan' };
  }

  if (limits.max_faces_per_camera === -1) return { allowed: true };

  const [rows] = await this.pool.execute(
    'SELECT COUNT(*) as count FROM camera_faces WHERE camera_id = ?',
    [cameraId]
  );
  const currentFaces = rows[0].count;

  return {
    allowed: currentFaces < limits.max_faces_per_camera,
    current: currentFaces,
    limit: limits.max_faces_per_camera,
    reason: currentFaces >= limits.max_faces_per_camera ? 'Face limit per camera reached' : null
  };
};

DatabaseService.prototype.getAllUsersPaginated = async function(page = 1, limit = 20, filters = {}) {
  page = Number(page) || 1; limit = Number(limit) || 20;
  const MAX_LIMIT = 100;
  limit = Math.min(Math.max(1, limit), MAX_LIMIT);
  const offset = (page - 1) * limit;

  let whereClause = '1=1';
  const params = [];

  if (filters.plan_id) { whereClause += ' AND u.plan_id = ?'; params.push(filters.plan_id); }
  if (filters.role) { whereClause += ' AND u.role = ?'; params.push(filters.role); }
  if (filters.is_active !== undefined) { whereClause += ' AND u.is_active = ?'; params.push(filters.is_active ? 1 : 0); }
  if (filters.search) {
    whereClause += ' AND (u.email LIKE ? OR u.display_name LIKE ?)';
    const searchTerm = `%${filters.search}%`;
    params.push(searchTerm, searchTerm);
  }

  const [items] = await this.pool.execute(`
    SELECT u.id, u.email, u.display_name, u.avatar_url, u.role, u.plan_id, u.is_active,
           u.last_login, u.created_at, u.notes,
           p.name as plan_name, p.display_name as plan_display_name,
           COALESCE(cc.camera_count, 0) as camera_count
    FROM users u
    LEFT JOIN user_plans p ON p.id = u.plan_id
    LEFT JOIN (SELECT user_id, COUNT(*) as camera_count FROM cameras GROUP BY user_id) cc ON cc.user_id = u.id
    WHERE ${whereClause}
    ORDER BY u.created_at DESC
    LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
  `, params);

  const [countRows] = await this.pool.execute(
    `SELECT COUNT(*) as count FROM users u WHERE ${whereClause}`,
    params
  );
  const total = countRows[0].count;

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total }
  };
};

DatabaseService.prototype.getUserDetail = async function(userId) {
  const [userRows] = await this.pool.execute(`
    SELECT u.*, p.name as plan_name, p.display_name as plan_display_name
    FROM users u
    LEFT JOIN user_plans p ON p.id = u.plan_id
    WHERE u.id = ?
  `, [userId]);
  const user = userRows[0];

  if (!user) return null;

  const limits = await this.getUserEffectiveLimits(userId);
  const overrides = await this.getUserOverrides(userId);
  const usage = await this.getUserTodayUsage(userId);
  const cameras = await this.getUserCameras(userId);

  return {
    ...user,
    limits,
    overrides,
    usage,
    cameras,
    camera_count: cameras.length
  };
};

DatabaseService.prototype.updateUserNotes = async function(userId, notes) {
  await this.pool.execute('UPDATE users SET notes = ? WHERE id = ?', [notes, userId]);
  return { success: true };
};

DatabaseService.prototype.getAdminStats = async function() {
  const [totalUsersRows] = await this.pool.execute('SELECT COUNT(*) as count FROM users');
  const [activeUsersRows] = await this.pool.execute('SELECT COUNT(*) as count FROM users WHERE is_active = 1');
  const [totalCamerasRows] = await this.pool.execute('SELECT COUNT(*) as count FROM cameras');
  const [onlineCamerasRows] = await this.pool.execute(
    'SELECT COUNT(*) as count FROM cameras WHERE last_seen > DATE_SUB(NOW(), INTERVAL 5 MINUTE)'
  );

  const today = new Date().toISOString().split('T')[0];
  const [aiRows] = await this.pool.execute(
    'SELECT SUM(ai_analysis_count) as count FROM user_usage WHERE usage_date = ?',
    [today]
  );

  const [videoCountRows] = await this.pool.execute(
    "SELECT COUNT(*) as count FROM video_messages WHERE media_type = 'video'"
  );
  const [photoCountRows] = await this.pool.execute(
    "SELECT COUNT(*) as count FROM video_messages WHERE media_type = 'photo'"
  );

  const [planDistribution] = await this.pool.execute(`
    SELECT p.name, p.display_name, COUNT(u.id) as user_count
    FROM user_plans p
    LEFT JOIN users u ON u.plan_id = p.id
    GROUP BY p.id
    ORDER BY p.id
  `);

  return {
    total_users: totalUsersRows[0].count,
    active_users: activeUsersRows[0].count,
    total_cameras: totalCamerasRows[0].count,
    online_cameras: onlineCamerasRows[0].count,
    today_ai_queries: aiRows[0].count || 0,
    total_videos: videoCountRows[0].count,
    total_photos: photoCountRows[0].count,
    plan_distribution: planDistribution
  };
};

DatabaseService.prototype.createPlan = async function(planData) {
  try {
    const [result] = await this.pool.execute(`
      INSERT INTO user_plans (
        name, display_name, max_cameras, max_whep_cameras,
        ai_analysis_enabled, ai_daily_limit, face_recognition_enabled,
        max_faces_per_camera, recording_enabled, max_recording_hours,
        recording_retention_days, voice_call_enabled, face_login_enabled,
        voice_control_enabled, public_sharing_enabled, priority_support
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      planData.name, planData.display_name,
      planData.max_cameras ?? 2, planData.max_whep_cameras ?? 1,
      planData.ai_analysis_enabled ? 1 : 0, planData.ai_daily_limit ?? 0,
      planData.face_recognition_enabled ? 1 : 0, planData.max_faces_per_camera ?? 0,
      planData.recording_enabled ? 1 : 0, planData.max_recording_hours ?? 0,
      planData.recording_retention_days ?? 7, planData.voice_call_enabled ? 1 : 0,
      planData.face_login_enabled ? 1 : 0, planData.voice_control_enabled ? 1 : 0,
      planData.public_sharing_enabled ? 1 : 0, planData.priority_support ? 1 : 0
    ]);

    return { success: true, planId: result.insertId };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

DatabaseService.prototype.updatePlan = async function(planId, planData) {
  const updates = [];
  const values = [];

  const columns = [
    'display_name', 'max_cameras', 'max_whep_cameras',
    'ai_analysis_enabled', 'ai_daily_limit', 'face_recognition_enabled',
    'max_faces_per_camera', 'recording_enabled', 'max_recording_hours',
    'recording_retention_days', 'voice_call_enabled', 'face_login_enabled',
    'voice_control_enabled', 'public_sharing_enabled', 'priority_support'
  ];

  columns.forEach(col => {
    if (planData.hasOwnProperty(col)) {
      updates.push(`${col} = ?`);
      let value = planData[col];
      if (col.endsWith('_enabled') || col === 'priority_support') {
        value = value ? 1 : 0;
      }
      values.push(value);
    }
  });

  if (updates.length === 0) {
    return { success: false, error: 'No fields to update' };
  }

  values.push(planId);

  try {
    await this.pool.execute(`UPDATE user_plans SET ${updates.join(', ')} WHERE id = ?`, values);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

DatabaseService.prototype.deletePlan = async function(planId) {
  if (planId === 1) {
    return { success: false, error: 'Cannot delete the free plan' };
  }

  const [rows] = await this.pool.execute('SELECT COUNT(*) as count FROM users WHERE plan_id = ?', [planId]);
  if (rows[0].count > 0) {
    return { success: false, error: `Cannot delete plan: ${rows[0].count} users are using it` };
  }

  try {
    await this.pool.execute('DELETE FROM user_plans WHERE id = ?', [planId]);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

DatabaseService.prototype.getPlanUserCounts = async function() {
  const [rows] = await this.pool.execute('SELECT plan_id, COUNT(*) as count FROM users GROUP BY plan_id');
  return rows;
};

DatabaseService.prototype.getPlanUserCount = async function(planId) {
  const [rows] = await this.pool.execute('SELECT COUNT(*) as count FROM users WHERE plan_id = ?', [planId]);
  return rows[0].count;
};

};
