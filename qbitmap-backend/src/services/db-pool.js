const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'qbitmap',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'qbitmap',
  port: parseInt(process.env.DB_PORT || '3306'),
  connectionLimit: 20,
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  timezone: '+00:00',
  charset: 'utf8mb4',
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: false
});

module.exports = pool;
