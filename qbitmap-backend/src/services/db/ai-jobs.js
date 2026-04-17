/**
 * AI Jobs - DB-backed persistent queue for AI analysis
 */

module.exports = function (DatabaseService) {
  DatabaseService.prototype.createAiJob = async function (messageId, jobType, subId = 0) {
    await this.pool.execute(
      'INSERT IGNORE INTO ai_jobs (message_id, sub_id, job_type, status) VALUES (?, ?, ?, ?)',
      [messageId, subId, jobType, 'pending']
    );
  };

  // Claim next pending jobs (atomic: SELECT + UPDATE in one go to prevent double-processing)
  DatabaseService.prototype.claimAiJobs = async function (jobType, limit) {
    const safeLimit = Math.max(1, Math.min(parseInt(limit) || 1, 10));
    // Get pending jobs that are ready for processing
    const [rows] = await this.pool.execute(
      `SELECT id, message_id, sub_id, job_type, retries FROM ai_jobs
       WHERE job_type = ? AND status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY created_at ASC LIMIT ${safeLimit}`,
      [jobType]
    );
    if (rows.length === 0) return [];

    const ids = rows.map(r => r.id);
    await this.pool.execute(
      `UPDATE ai_jobs SET status = 'processing', updated_at = NOW() WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    return rows;
  };

  DatabaseService.prototype.completeAiJob = async function (messageId, subId = 0) {
    await this.pool.execute(
      `UPDATE ai_jobs SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE message_id = ? AND sub_id = ?`,
      [messageId, subId]
    );
  };

  DatabaseService.prototype.failAiJob = async function (messageId, subId, errorMessage) {
    // Increment retries, set next_retry_at with exponential backoff, or mark failed if max retries reached
    await this.pool.execute(
      `UPDATE ai_jobs SET
        retries = retries + 1,
        error_message = ?,
        status = IF(retries + 1 >= max_retries, 'failed', 'pending'),
        next_retry_at = IF(retries + 1 >= max_retries, NULL, DATE_ADD(NOW(), INTERVAL POW(2, retries) * 10 SECOND)),
        updated_at = NOW()
      WHERE message_id = ? AND sub_id = ?`,
      [errorMessage, messageId, subId]
    );
  };

  // Count currently processing jobs by type
  DatabaseService.prototype.countActiveAiJobs = async function (jobType) {
    const [rows] = await this.pool.execute(
      `SELECT COUNT(*) as cnt FROM ai_jobs WHERE job_type = ? AND status = 'processing'`,
      [jobType]
    );
    return rows[0].cnt;
  };

  // Recover stuck jobs (processing for too long — likely from a crash)
  DatabaseService.prototype.recoverStuckAiJobs = async function (timeoutMinutes = 5) {
    const safeMinutes = Math.max(1, parseInt(timeoutMinutes) || 5);
    const [result] = await this.pool.execute(
      `UPDATE ai_jobs SET status = 'pending', updated_at = NOW()
       WHERE status = 'processing' AND updated_at < DATE_SUB(NOW(), INTERVAL ${safeMinutes} MINUTE)`
    );
    return result.affectedRows;
  };

  // Get pending job count (for monitoring)
  DatabaseService.prototype.getPendingAiJobCount = async function () {
    const [rows] = await this.pool.execute(
      `SELECT job_type, COUNT(*) as cnt FROM ai_jobs WHERE status IN ('pending', 'processing') GROUP BY job_type`
    );
    return rows;
  };
};
