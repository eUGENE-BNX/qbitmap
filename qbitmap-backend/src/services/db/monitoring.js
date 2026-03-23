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
    'SELECT face_detection_enabled, face_detection_interval, alarm_trigger_names FROM cameras WHERE id = ?',
    [cameraId]
  );
  return rows[0];
};

DatabaseService.prototype.updateFaceDetectionSettings = async function(cameraId, userId, enabled, interval, alarmTriggerNames) {
  if (!(await this.isUserCameraOwner(userId, cameraId))) {
    return { success: false, error: 'Not authorized' };
  }
  const updates = [];
  const params = [];
  if (enabled !== undefined) { updates.push('face_detection_enabled = ?'); params.push(enabled ? 1 : 0); }
  if (interval !== undefined) { updates.push('face_detection_interval = ?'); params.push(interval); }
  if (alarmTriggerNames !== undefined) { updates.push('alarm_trigger_names = ?'); params.push(alarmTriggerNames); }
  if (updates.length > 0) {
    params.push(cameraId);
    await this.pool.execute('UPDATE cameras SET ' + updates.join(', ') + ' WHERE id = ?', params);
  }
  return { success: true };
};

DatabaseService.prototype.getCameraFaces = async function(cameraId) {
  const [rows] = await this.pool.execute(
    'SELECT id, person_id, name, face_image_url, trigger_alarm, created_at FROM camera_faces WHERE camera_id = ? ORDER BY created_at DESC',
    [cameraId]
  );
  return rows;
};

DatabaseService.prototype.addCameraFace = async function(cameraId, personId, name, faceImageUrl) {
  const [result] = await this.pool.execute(
    'INSERT INTO camera_faces (camera_id, person_id, name, face_image_url) VALUES (?, ?, ?, ?)',
    [cameraId, personId, name, faceImageUrl]
  );
  return { success: true, faceId: result.insertId };
};

DatabaseService.prototype.removeCameraFace = async function(faceId, cameraId) {
  const [rows] = await this.pool.execute('SELECT * FROM camera_faces WHERE id = ? AND camera_id = ?', [faceId, cameraId]);
  const face = rows[0];
  if (!face) return { success: false, error: 'Face not found' };
  await this.pool.execute('DELETE FROM camera_faces WHERE id = ?', [faceId]);
  return { success: true, personId: face.person_id };
};

DatabaseService.prototype.updateFaceAlarm = async function(faceId, cameraId, triggerAlarm) {
  const [rows] = await this.pool.execute('SELECT * FROM camera_faces WHERE id = ? AND camera_id = ?', [faceId, cameraId]);
  if (!rows[0]) return { success: false, error: 'Face not found' };
  await this.pool.execute('UPDATE camera_faces SET trigger_alarm = ? WHERE id = ?', [triggerAlarm ? 1 : 0, faceId]);
  return { success: true };
};

DatabaseService.prototype.getFaceByPersonId = async function(cameraId, personId) {
  const [rows] = await this.pool.execute(
    'SELECT id, person_id, name, face_image_url, trigger_alarm FROM camera_faces WHERE camera_id = ? AND person_id = ?',
    [cameraId, personId]
  );
  return rows[0];
};

DatabaseService.prototype.logFaceDetection = async function(cameraId, faceId, personName, confidence) {
  await this.pool.execute(
    'INSERT INTO face_detection_log (camera_id, face_id, person_name, confidence) VALUES (?, ?, ?, ?)',
    [cameraId, faceId, personName, confidence]
  );
};

DatabaseService.prototype.getFaceDetectionLogs = async function(cameraId, limit = 10) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 200);
  const [rows] = await this.pool.execute(
    `SELECT l.id, l.face_id, l.person_name, l.confidence, l.detected_at, f.face_image_url FROM face_detection_log l LEFT JOIN camera_faces f ON l.face_id = f.id WHERE l.camera_id = ? ORDER BY l.detected_at DESC LIMIT ${safeLimit}`,
    [cameraId]
  );
  return rows;
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
  const [rows] = await this.pool.execute(`
    SELECT cf.id, cf.person_id, cf.name, cf.face_image_url, cf.trigger_alarm, c.name as camera_name
    FROM camera_faces cf
    JOIN cameras c ON cf.camera_id = c.id
    WHERE c.user_id = ?
    ORDER BY cf.name
  `, [userId]);
  return rows;
};

DatabaseService.prototype.getAlarmCount = async function() {
  const [rows] = await this.pool.execute('SELECT COUNT(*) as count FROM alarms WHERE cleared_at IS NULL');
  return rows[0].count;
};

};
