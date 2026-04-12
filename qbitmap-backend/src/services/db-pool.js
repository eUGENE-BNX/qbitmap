const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'qbitmap',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'qbitmap',
  port: parseInt(process.env.DB_PORT || '3306'),
  connectionLimit: 50,
  waitForConnections: true,
  // [PERF-17] Bound the wait queue so a burst can't pile up unbounded
  // pending queries in memory (the old queueLimit:0 meant infinite).
  // When the queue is full, mysql2 throws POOL_ENQUEUELIMIT which the
  // global error handler maps to 503 via the status code on the error.
  queueLimit: 200,
  maxIdle: 10,
  idleTimeout: 60000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  timezone: '+00:00',
  charset: 'utf8mb4',
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: false
});

module.exports = pool;
