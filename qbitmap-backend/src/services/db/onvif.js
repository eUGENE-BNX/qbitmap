module.exports = function(DatabaseService) {

DatabaseService.prototype.seedOnvifTemplates = async function() {
  const templates = [
    { model_name: 'Tapo C100', manufacturer: 'TP-Link', onvif_port: 2020, supported_events: JSON.stringify(['motion', 'human']) },
    { model_name: 'Tapo C200', manufacturer: 'TP-Link', onvif_port: 2020, supported_events: JSON.stringify(['motion', 'human', 'pet']) },
    { model_name: 'Tapo C210', manufacturer: 'TP-Link', onvif_port: 2020, supported_events: JSON.stringify(['motion', 'human', 'pet']) }
  ];

  for (const t of templates) {
    try {
      await this.pool.execute(
        'INSERT IGNORE INTO onvif_camera_templates (model_name, manufacturer, onvif_port, supported_events) VALUES (?, ?, ?, ?)',
        [t.model_name, t.manufacturer, t.onvif_port, t.supported_events]
      );
    } catch (e) {
      // Ignore duplicate errors
    }
  }
};

DatabaseService.prototype.getOnvifTemplates = async function() {
  const [rows] = await this.pool.execute(
    'SELECT id, model_name, manufacturer, onvif_port, supported_events, created_at FROM onvif_camera_templates ORDER BY manufacturer, model_name'
  );
  return rows;
};

DatabaseService.prototype.getOnvifTemplateById = async function(templateId) {
  const [rows] = await this.pool.execute(
    'SELECT id, model_name, manufacturer, onvif_port, supported_events, created_at FROM onvif_camera_templates WHERE id = ?',
    [templateId]
  );
  return rows[0];
};

DatabaseService.prototype.createOnvifTemplate = async function({ modelName, manufacturer, onvifPort, supportedEvents }) {
  try {
    const [result] = await this.pool.execute(
      'INSERT INTO onvif_camera_templates (model_name, manufacturer, onvif_port, supported_events) VALUES (?, ?, ?, ?)',
      [modelName, manufacturer, onvifPort, JSON.stringify(supportedEvents)]
    );

    const template = await this.getOnvifTemplateById(result.insertId);
    return { success: true, template };
  } catch (error) {
    console.error('[Database] Create ONVIF template error:', error);
    return { success: false, error: error.message };
  }
};

DatabaseService.prototype.updateOnvifTemplate = async function(templateId, { modelName, manufacturer, onvifPort, supportedEvents }) {
  try {
    const updates = [];
    const values = [];

    if (modelName !== undefined) { updates.push('model_name = ?'); values.push(modelName); }
    if (manufacturer !== undefined) { updates.push('manufacturer = ?'); values.push(manufacturer); }
    if (onvifPort !== undefined) { updates.push('onvif_port = ?'); values.push(onvifPort); }
    if (supportedEvents !== undefined) { updates.push('supported_events = ?'); values.push(JSON.stringify(supportedEvents)); }

    if (updates.length === 0) return { success: true };

    values.push(templateId);
    await this.pool.execute(`UPDATE onvif_camera_templates SET ${updates.join(', ')} WHERE id = ?`, values);

    return { success: true };
  } catch (error) {
    console.error('[Database] Update ONVIF template error:', error);
    return { success: false, error: error.message };
  }
};

DatabaseService.prototype.deleteOnvifTemplate = async function(templateId) {
  try {
    const [rows] = await this.pool.execute(
      'SELECT COUNT(*) as count FROM camera_onvif_links WHERE onvif_template_id = ?',
      [templateId]
    );

    if (rows[0].count > 0) {
      return { success: false, error: `Template is in use by ${rows[0].count} camera(s)` };
    }

    await this.pool.execute('DELETE FROM onvif_camera_templates WHERE id = ?', [templateId]);
    return { success: true };
  } catch (error) {
    console.error('[Database] Delete ONVIF template error:', error);
    return { success: false, error: error.message };
  }
};

DatabaseService.prototype.createOnvifLink = async function(qbitmapCameraId, onvifCameraId, templateId) {
  try {
    await this.pool.execute('DELETE FROM camera_onvif_links WHERE onvif_camera_id = ?', [onvifCameraId]);

    await this.pool.execute(
      'REPLACE INTO camera_onvif_links (qbitmap_camera_id, onvif_camera_id, onvif_template_id) VALUES (?, ?, ?)',
      [qbitmapCameraId, onvifCameraId, templateId]
    );

    return { success: true };
  } catch (error) {
    console.error('[Database] Create ONVIF link error:', error);
    return { success: false, error: error.message };
  }
};

DatabaseService.prototype.getOnvifLink = async function(qbitmapCameraId) {
  const [rows] = await this.pool.execute(`
    SELECT col.*, oct.model_name, oct.manufacturer, oct.supported_events
    FROM camera_onvif_links col
    JOIN onvif_camera_templates oct ON oct.id = col.onvif_template_id
    WHERE col.qbitmap_camera_id = ?
  `, [qbitmapCameraId]);
  return rows[0];
};

DatabaseService.prototype.getOnvifLinkByOnvifId = async function(onvifCameraId) {
  const [rows] = await this.pool.execute(`
    SELECT col.*, oct.model_name, oct.manufacturer
    FROM camera_onvif_links col
    JOIN onvif_camera_templates oct ON oct.id = col.onvif_template_id
    WHERE col.onvif_camera_id = ?
  `, [onvifCameraId]);
  return rows[0];
};

DatabaseService.prototype.getAllOnvifLinks = async function() {
  const [rows] = await this.pool.execute(`
    SELECT col.*, c.device_id, c.name, oct.model_name, oct.manufacturer
    FROM camera_onvif_links col
    JOIN cameras c ON c.id = col.qbitmap_camera_id
    JOIN onvif_camera_templates oct ON oct.id = col.onvif_template_id
    ORDER BY col.created_at DESC
  `);
  return rows;
};

DatabaseService.prototype.deleteOnvifLink = async function(qbitmapCameraId) {
  try {
    await this.pool.execute('DELETE FROM camera_onvif_links WHERE qbitmap_camera_id = ?', [qbitmapCameraId]);
    return { success: true };
  } catch (error) {
    console.error('[Database] Delete ONVIF link error:', error);
    return { success: false, error: error.message };
  }
};

DatabaseService.prototype.updateOnvifLinkTemplate = async function(qbitmapCameraId, templateId) {
  try {
    const [result] = await this.pool.execute(
      'UPDATE camera_onvif_links SET onvif_template_id = ? WHERE qbitmap_camera_id = ?',
      [templateId, qbitmapCameraId]
    );

    if (result.affectedRows === 0) {
      return { success: false, error: 'Link not found' };
    }

    return { success: true };
  } catch (error) {
    console.error('[Database] Update ONVIF link template error:', error);
    return { success: false, error: error.message };
  }
};

DatabaseService.prototype.saveOnvifEvent = async function(cameraId, eventType, eventState, eventData) {
  try {
    const [result] = await this.pool.execute(
      'INSERT INTO onvif_events (camera_id, event_type, event_state, event_data) VALUES (?, ?, ?, ?)',
      [cameraId, eventType, eventState ? 1 : 0, eventData != null ? JSON.stringify(eventData) : null]
    );
    return result.insertId;
  } catch (error) {
    console.error('[Database] Save ONVIF event error:', error);
    return null;
  }
};

DatabaseService.prototype.getOnvifEvents = async function(cameraId, limit = 100) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || 100, 1), 500);
  const [rows] = await this.pool.execute(
    `SELECT id, camera_id, event_type, event_state, event_data, \`timestamp\` FROM onvif_events WHERE camera_id = ? ORDER BY \`timestamp\` DESC LIMIT ${safeLimit}`,
    [cameraId]
  );
  return rows;
};

DatabaseService.prototype.getAllRecentOnvifEvents = async function(limit = 50) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
  const [rows] = await this.pool.query(`
    SELECT oe.*, c.device_id, c.name
    FROM onvif_events oe
    JOIN cameras c ON c.id = oe.camera_id
    ORDER BY oe.\`timestamp\` DESC
    LIMIT ${safeLimit}
  `);
  return rows;
};

};
