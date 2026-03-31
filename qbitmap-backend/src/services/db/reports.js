const logger = require('../../utils/logger').child({ module: 'db-reports' });

module.exports = function(DatabaseService) {

DatabaseService.prototype.createReport = async function(userId, entityType, entityId, reason, detail) {
  const conn = await this.pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.execute(
      'INSERT INTO reports (entity_type, entity_id, user_id, reason, detail) VALUES (?, ?, ?, ?, ?)',
      [entityType, entityId, userId, reason, detail || null]
    );

    // Upsert report_counts
    await conn.execute(
      'INSERT INTO report_counts (entity_type, entity_id, report_count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE report_count = report_count + 1',
      [entityType, entityId]
    );

    await conn.commit();
    return { success: true, reportId: result.insertId };
  } catch (error) {
    await conn.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      return { success: false, duplicate: true };
    }
    logger.error({ err: error }, 'Create report error');
    return { success: false, error: error.message };
  } finally {
    conn.release();
  }
};

DatabaseService.prototype.getReportStatus = async function(entityType, entityId, userId) {
  const [rows] = await this.pool.execute(
    'SELECT id FROM reports WHERE entity_type = ? AND entity_id = ? AND user_id = ?',
    [entityType, entityId, userId]
  );
  return { reported: rows.length > 0 };
};

DatabaseService.prototype.getAdminReports = async function(page, limit, filters = {}) {
  let where = 'WHERE 1=1';
  const params = [];

  if (filters.status) {
    where += ' AND r.status = ?';
    params.push(filters.status);
  }

  if (filters.entityType) {
    where += ' AND r.entity_type = ?';
    params.push(filters.entityType);
  }

  if (filters.search) {
    where += ' AND (r.entity_id LIKE ? OR r.detail LIKE ? OR u.name LIKE ? OR u.email LIKE ?)';
    const s = `%${filters.search}%`;
    params.push(s, s, s, s);
  }

  // Count total
  const [countRows] = await this.pool.execute(
    `SELECT COUNT(*) as total FROM reports r JOIN users u ON r.user_id = u.id ${where}`,
    params
  );
  const total = countRows[0].total;

  // Fetch items
  const offset = (page - 1) * limit;
  const [rows] = await this.pool.execute(
    `SELECT r.*, u.display_name AS reporter_name, u.email AS reporter_email, u.avatar_url AS reporter_avatar,
            ru.display_name AS resolved_by_name,
            vm.thumbnail_path, vm.lat AS content_lat, vm.lng AS content_lng, vm.media_type, vm.description AS content_description
     FROM reports r
     JOIN users u ON r.user_id = u.id
     LEFT JOIN users ru ON r.resolved_by = ru.id
     LEFT JOIN video_messages vm ON r.entity_type = 'video_message' AND r.entity_id = vm.message_id
     ${where}
     ORDER BY r.status = 'pending' DESC, r.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  );

  return {
    items: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
};

DatabaseService.prototype.getReportById = async function(reportId) {
  const [rows] = await this.pool.execute('SELECT * FROM reports WHERE id = ?', [reportId]);
  return rows[0] || null;
};

DatabaseService.prototype.resolveReport = async function(reportId, adminUserId, action) {
  const status = action === 'dismiss' ? 'dismissed' : 'resolved';
  const [result] = await this.pool.execute(
    'UPDATE reports SET status = ?, resolved_by = ?, resolved_at = NOW() WHERE id = ? AND status = ?',
    [status, adminUserId, reportId, 'pending']
  );
  return result.affectedRows > 0;
};

// Resolve all pending reports for an entity (used when content is deleted)
DatabaseService.prototype.resolveReportsByEntity = async function(entityType, entityId, adminUserId) {
  await this.pool.execute(
    "UPDATE reports SET status = 'resolved', resolved_by = ?, resolved_at = NOW() WHERE entity_type = ? AND entity_id = ? AND status = 'pending'",
    [adminUserId, entityType, entityId]
  );
};

DatabaseService.prototype.getReportCount = async function(entityType, entityId) {
  const [rows] = await this.pool.execute(
    'SELECT report_count FROM report_counts WHERE entity_type = ? AND entity_id = ?',
    [entityType, entityId]
  );
  return rows[0]?.report_count || 0;
};

DatabaseService.prototype.getPendingReportCount = async function() {
  const [rows] = await this.pool.execute(
    "SELECT COUNT(*) as count FROM reports WHERE status = 'pending'"
  );
  return rows[0].count;
};

};
