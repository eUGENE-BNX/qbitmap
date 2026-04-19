module.exports = function(DatabaseService) {

DatabaseService.prototype.getAiMonitoringState = async function(cameraId) {
  const [rows] = await this.pool.execute('SELECT * FROM ai_monitoring WHERE camera_id = ?', [cameraId]);
  return rows[0];
};

DatabaseService.prototype.setAiMonitoring = async function(cameraId, enabled, userId) {
  const existing = await this.getAiMonitoringState(cameraId);

  if (existing) {
    await this.pool.execute(
      'UPDATE ai_monitoring SET enabled = ?, started_by_user_id = ?, started_at = NOW(), config_version = config_version + 1 WHERE camera_id = ?',
      [enabled ? 1 : 0, userId, cameraId]
    );
  } else {
    await this.pool.execute(
      'INSERT INTO ai_monitoring (camera_id, enabled, started_by_user_id) VALUES (?, ?, ?)',
      [cameraId, enabled ? 1 : 0, userId]
    );
  }

  return this.getAiMonitoringState(cameraId);
};

DatabaseService.prototype.updateLastAnalysis = async function(cameraId) {
  await this.pool.execute('UPDATE ai_monitoring SET last_analysis_at = NOW() WHERE camera_id = ?', [cameraId]);
};

DatabaseService.prototype.getAllActiveMonitoring = async function() {
  const [rows] = await this.pool.execute(`
    SELECT am.*, c.device_id, c.name, c.camera_type, c.whep_url
    FROM ai_monitoring am
    JOIN cameras c ON c.id = am.camera_id
    WHERE am.enabled = 1
  `);
  return rows;
};

DatabaseService.prototype.getActiveMonitoringForUser = async function(userId) {
  const [rows] = await this.pool.execute(`
    SELECT am.*, c.device_id, c.name, c.camera_type, c.whep_url
    FROM ai_monitoring am
    JOIN cameras c ON c.id = am.camera_id
    WHERE am.enabled = 1
      AND (
        c.user_id = ?
        OR c.is_public = 1
        OR EXISTS (
          SELECT 1 FROM camera_shares cs
          WHERE cs.camera_id = c.id AND cs.shared_with_user_id = ?
        )
      )
  `, [userId, userId]);
  return rows;
};

DatabaseService.prototype.createAlarm = async function(cameraId, deviceId, alarmData) {
  const [result] = await this.pool.execute(
    'INSERT INTO alarms (camera_id, device_id, alarm_data) VALUES (?, ?, ?)',
    [cameraId, deviceId, JSON.stringify(alarmData)]
  );
  return result.insertId;
};

DatabaseService.prototype.getActiveAlarm = async function(cameraId) {
  const [rows] = await this.pool.execute(
    'SELECT * FROM alarms WHERE camera_id = ? AND cleared_at IS NULL ORDER BY triggered_at DESC LIMIT 1',
    [cameraId]
  );
  return rows[0];
};

DatabaseService.prototype.clearAlarm = async function(alarmId, userId) {
  await this.pool.execute(
    'UPDATE alarms SET cleared_at = NOW(), cleared_by_user_id = ? WHERE id = ?',
    [userId, alarmId]
  );
};

DatabaseService.prototype.getAllActiveAlarms = async function() {
  const [rows] = await this.pool.execute(`
    SELECT a.*, c.device_id, c.name
    FROM alarms a
    JOIN cameras c ON c.id = a.camera_id
    WHERE a.cleared_at IS NULL
    ORDER BY a.triggered_at DESC
  `);
  return rows;
};

DatabaseService.prototype.getActiveAlarmsForUser = async function(userId) {
  const [rows] = await this.pool.execute(`
    SELECT a.*, c.device_id, c.name
    FROM alarms a
    JOIN cameras c ON c.id = a.camera_id
    WHERE a.cleared_at IS NULL
      AND (
        c.user_id = ?
        OR c.is_public = 1
        OR EXISTS (
          SELECT 1 FROM camera_shares cs
          WHERE cs.camera_id = c.id AND cs.shared_with_user_id = ?
        )
      )
    ORDER BY a.triggered_at DESC
  `, [userId, userId]);
  return rows;
};

DatabaseService.prototype.getCameraAlarmHistory = async function(cameraId, limit = 50) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  const [rows] = await this.pool.execute(
    `SELECT * FROM alarms WHERE camera_id = ? ORDER BY triggered_at DESC LIMIT ${safeLimit}`,
    [cameraId]
  );
  return rows;
};

DatabaseService.prototype.getAlarmById = async function(alarmId) {
  const [rows] = await this.pool.execute('SELECT * FROM alarms WHERE id = ?', [alarmId]);
  return rows[0];
};

DatabaseService.prototype.getFaceDetectionSettings = async function(cameraId) {
  const [rows] = await this.pool.execute(
    'SELECT face_detection_enabled, face_detection_interval, face_match_threshold, alarm_trigger_names FROM cameras WHERE id = ?',
    [cameraId]
  );
  return rows[0];
};

DatabaseService.prototype.updateFaceDetectionSettings = async function(cameraId, userId, enabled, interval, alarmTriggerNames, matchThreshold) {
  if (!(await this.isUserCameraOwner(userId, cameraId))) {
    return { success: false, error: 'Not authorized' };
  }
  const updates = [];
  const params = [];
  if (enabled !== undefined) { updates.push('face_detection_enabled = ?'); params.push(enabled ? 1 : 0); }
  if (interval !== undefined) { updates.push('face_detection_interval = ?'); params.push(interval); }
  if (alarmTriggerNames !== undefined) { updates.push('alarm_trigger_names = ?'); params.push(alarmTriggerNames); }
  if (matchThreshold !== undefined) {
    const t = Math.min(Math.max(parseInt(matchThreshold, 10) || 70, 50), 95);
    updates.push('face_match_threshold = ?'); params.push(t);
  }
  if (updates.length > 0) {
    params.push(cameraId);
    await this.pool.execute('UPDATE cameras SET ' + updates.join(', ') + ' WHERE id = ?', params);
  }
  return { success: true };
};

// Global user-level face library. getCameraFaces is kept as a thin alias so
// the old route contract stays intact — it now reads user_faces scoped to
// the camera's owner instead of per-camera rows.
DatabaseService.prototype.getUserFaces = async function(userId) {
  const [rows] = await this.pool.execute(
    'SELECT id, person_id, name, face_image_url, trigger_alarm, created_at FROM user_faces WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  );
  return rows;
};

DatabaseService.prototype.getCameraFaces = async function(cameraId) {
  const [cam] = await this.pool.execute('SELECT user_id FROM cameras WHERE id = ?', [cameraId]);
  if (!cam[0]) return [];
  return this.getUserFaces(cam[0].user_id);
};

DatabaseService.prototype.addUserFace = async function(userId, personId, name, faceImageUrl) {
  try {
    const [result] = await this.pool.execute(
      'INSERT INTO user_faces (user_id, person_id, name, face_image_url) VALUES (?, ?, ?, ?)',
      [userId, personId, name, faceImageUrl]
    );
    return { success: true, faceId: result.insertId };
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return { success: false, error: 'Face already exists' };
    throw e;
  }
};

DatabaseService.prototype.removeUserFace = async function(faceId, userId) {
  const [rows] = await this.pool.execute(
    'SELECT * FROM user_faces WHERE id = ? AND user_id = ?',
    [faceId, userId]
  );
  const face = rows[0];
  if (!face) return { success: false, error: 'Face not found' };
  await this.pool.execute('DELETE FROM user_faces WHERE id = ?', [faceId]);
  return { success: true, personId: face.person_id };
};

DatabaseService.prototype.updateUserFaceAlarm = async function(faceId, userId, triggerAlarm) {
  const [result] = await this.pool.execute(
    'UPDATE user_faces SET trigger_alarm = ? WHERE id = ? AND user_id = ?',
    [triggerAlarm ? 1 : 0, faceId, userId]
  );
  if (result.affectedRows === 0) return { success: false, error: 'Face not found' };
  return { success: true };
};

DatabaseService.prototype.getUserFaceByPersonId = async function(userId, personId) {
  const [rows] = await this.pool.execute(
    'SELECT id, person_id, name, face_image_url, trigger_alarm FROM user_faces WHERE user_id = ? AND person_id = ?',
    [userId, personId]
  );
  return rows[0];
};

DatabaseService.prototype.getUserFaceById = async function(faceId, userId) {
  const [rows] = await this.pool.execute(
    'SELECT id, person_id, name, face_image_url, trigger_alarm FROM user_faces WHERE id = ? AND user_id = ?',
    [faceId, userId]
  );
  return rows[0];
};

DatabaseService.prototype.logFaceDetection = async function(cameraId, userFaceId, personName, confidence) {
  await this.pool.execute(
    'INSERT INTO face_detection_log (camera_id, user_face_id, person_name, confidence) VALUES (?, ?, ?, ?)',
    [cameraId, userFaceId || null, personName, confidence]
  );
};

DatabaseService.prototype.getFaceDetectionLogs = async function(cameraId, limit = 10) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 200);
  const [rows] = await this.pool.execute(
    `SELECT l.id, l.user_face_id AS face_id, l.person_name, l.confidence, l.detected_at, uf.face_image_url
     FROM face_detection_log l
     LEFT JOIN user_faces uf ON l.user_face_id = uf.id
     WHERE l.camera_id = ? ORDER BY l.detected_at DESC LIMIT ${safeLimit}`,
    [cameraId]
  );
  return rows;
};

// Detection count for a given face across all of user's cameras in a
// time window. Used by face-absence-monitor to decide whether a window
// passed without the person being seen.
DatabaseService.prototype.countFaceDetectionsForUser = async function(userFaceId, userId, startIso, endIso) {
  const [rows] = await this.pool.execute(
    `SELECT COUNT(*) AS n
     FROM face_detection_log l
     JOIN cameras c ON c.id = l.camera_id
     WHERE l.user_face_id = ? AND c.user_id = ?
       AND l.detected_at >= ? AND l.detected_at <= ?`,
    [userFaceId, userId, startIso, endIso]
  );
  return rows[0]?.n || 0;
};

// -----------------------------------------------------------------
// Absence rules CRUD (face_absence_rules / face_absence_events)
// -----------------------------------------------------------------

DatabaseService.prototype.getFaceAbsenceRules = async function(userId) {
  const [rows] = await this.pool.execute(
    `SELECT r.*, uf.name AS face_name, uf.face_image_url
     FROM face_absence_rules r
     JOIN user_faces uf ON uf.id = r.user_face_id
     WHERE r.user_id = ?
     ORDER BY r.created_at DESC`,
    [userId]
  );
  return rows;
};

DatabaseService.prototype.getFaceAbsenceRuleById = async function(ruleId, userId) {
  const [rows] = await this.pool.execute(
    `SELECT r.*, uf.name AS face_name, uf.face_image_url
     FROM face_absence_rules r
     JOIN user_faces uf ON uf.id = r.user_face_id
     WHERE r.id = ? AND r.user_id = ?`,
    [ruleId, userId]
  );
  return rows[0];
};

DatabaseService.prototype.addFaceAbsenceRule = async function(userId, data) {
  const { user_face_id, label, start_time, end_time, day_of_week_mask, enabled, voice_call_enabled } = data;
  // Verify face belongs to user
  const face = await this.getUserFaceById(user_face_id, userId);
  if (!face) return { success: false, error: 'Face not found' };
  const [result] = await this.pool.execute(
    `INSERT INTO face_absence_rules
       (user_id, user_face_id, label, start_time, end_time, day_of_week_mask, enabled, voice_call_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      user_face_id,
      label || null,
      start_time,
      end_time,
      day_of_week_mask ?? 127,
      enabled ? 1 : 0,
      voice_call_enabled ? 1 : 0
    ]
  );
  return { success: true, ruleId: result.insertId };
};

DatabaseService.prototype.updateFaceAbsenceRule = async function(ruleId, userId, data) {
  const fields = ['user_face_id', 'label', 'start_time', 'end_time', 'day_of_week_mask', 'enabled', 'voice_call_enabled'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (data[f] === undefined) continue;
    let val = data[f];
    if (f === 'enabled' || f === 'voice_call_enabled') val = val ? 1 : 0;
    updates.push(`${f} = ?`);
    params.push(val);
  }
  if (updates.length === 0) return { success: true };
  params.push(ruleId, userId);
  const [result] = await this.pool.execute(
    `UPDATE face_absence_rules SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
    params
  );
  if (result.affectedRows === 0) return { success: false, error: 'Rule not found' };
  return { success: true };
};

DatabaseService.prototype.deleteFaceAbsenceRule = async function(ruleId, userId) {
  const [result] = await this.pool.execute(
    'DELETE FROM face_absence_rules WHERE id = ? AND user_id = ?',
    [ruleId, userId]
  );
  if (result.affectedRows === 0) return { success: false, error: 'Rule not found' };
  return { success: true };
};

// Cron helper: find rules whose window just ended and haven't fired today.
// Rule matches when:
//   • enabled = 1
//   • end_time falls inside the last minute
//   • today's weekday bit is set in day_of_week_mask
//   • face_absence_events row for (rule, today) does NOT yet exist
DatabaseService.prototype.getDueAbsenceRules = async function() {
  const [rows] = await this.pool.execute(
    `SELECT r.*
     FROM face_absence_rules r
     LEFT JOIN face_absence_events e
       ON e.rule_id = r.id AND e.window_date = CURDATE()
     WHERE r.enabled = 1
       AND r.end_time BETWEEN DATE_SUB(CURTIME(), INTERVAL 90 SECOND) AND CURTIME()
       AND (r.day_of_week_mask & (1 << WEEKDAY(CURDATE()))) != 0
       AND e.id IS NULL`
  );
  return rows;
};

// INSERT IGNORE keeps this idempotent: if two cron ticks race, the second
// sees the UNIQUE (rule_id, window_date) constraint hit and does nothing.
DatabaseService.prototype.recordAbsenceEvent = async function(ruleId) {
  const [result] = await this.pool.execute(
    'INSERT IGNORE INTO face_absence_events (rule_id, window_date) VALUES (?, CURDATE())',
    [ruleId]
  );
  return result.affectedRows > 0;
};

DatabaseService.prototype.getCamerasWithFaceDetection = async function() {
  const [rows] = await this.pool.execute(
    'SELECT c.id, c.device_id, c.name, c.user_id, c.camera_type, c.whep_url, c.face_detection_interval FROM cameras c WHERE c.face_detection_enabled = 1'
  );
  return rows;
};

DatabaseService.prototype.getVoiceCallEnabled = async function(cameraId) {
  const [rows] = await this.pool.execute('SELECT voice_call_enabled FROM cameras WHERE id = ?', [cameraId]);
  return rows[0] ? !!rows[0].voice_call_enabled : false;
};

DatabaseService.prototype.setVoiceCallEnabled = async function(cameraId, userId, enabled) {
  if (!(await this.isUserCameraOwner(userId, cameraId))) {
    return { success: false, error: 'You do not own this camera.' };
  }

  await this.pool.execute('UPDATE cameras SET voice_call_enabled = ? WHERE id = ?', [enabled ? 1 : 0, cameraId]);
  return { success: true, enabled: !!enabled };
};

DatabaseService.prototype.getCamerasWithVoiceCallEnabled = async function() {
  const [rows] = await this.pool.execute(
    'SELECT id, device_id, name, user_id FROM cameras WHERE voice_call_enabled = 1'
  );
  return rows;
};

DatabaseService.prototype.setAudioMuted = async function(cameraId, userId, muted) {
  if (!(await this.isUserCameraOwner(userId, cameraId))) {
    return { success: false, error: 'You do not own this camera.' };
  }

  await this.pool.execute('UPDATE cameras SET audio_muted = ? WHERE id = ?', [muted ? 1 : 0, cameraId]);
  return { success: true, muted: !!muted };
};

DatabaseService.prototype.getActiveFaceDetectionCameras = async function(userId) {
  const [rows] = await this.pool.execute(
    'SELECT device_id, name, face_detection_enabled, face_detection_interval FROM cameras WHERE user_id = ? AND face_detection_enabled = 1',
    [userId]
  );
  return rows;
};

DatabaseService.prototype.getUserFacesWithCameraNames = async function(userId) {
  // Post-refactor: faces are user-scoped, not per-camera. Kept under the old
  // name so existing broadcast route keeps working; camera_name is always null.
  const [rows] = await this.pool.execute(`
    SELECT id, person_id, name, face_image_url, trigger_alarm, NULL AS camera_name
    FROM user_faces
    WHERE user_id = ?
    ORDER BY name
  `, [userId]);
  return rows;
};

DatabaseService.prototype.getAlarmCount = async function() {
  const [rows] = await this.pool.execute('SELECT COUNT(*) as count FROM alarms WHERE cleared_at IS NULL');
  return rows[0].count;
};

};
