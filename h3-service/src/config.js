const isProduction = process.env.NODE_ENV === 'production';

module.exports = {
  server: {
    host: '0.0.0.0',
    port: parseInt(process.env.PORT || '3100')
  },
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'qbitmap_h3',
    user: process.env.DB_USER || 'h3service',
    password: process.env.DB_PASSWORD || ''
  },
  cors: {
    origin: isProduction
      ? ['https://qbitmap.com', 'https://stream.qbitmap.com']
      : true,
    credentials: true
  },
  serviceKey: (() => {
    if (process.env.SERVICE_KEY) return process.env.SERVICE_KEY;
    if (isProduction) { console.error('FATAL: SERVICE_KEY required in production'); process.exit(1); }
    return 'dev-service-key';
  })(),
  qbitmap: {
    apiUrl: process.env.QBITMAP_API_URL || 'https://stream.qbitmap.com'
  },
  // Digital Land Ownership point values (extensible)
  pointValues: {
    camera: 50,
    video: 5,
    photo: 1
  }
};
