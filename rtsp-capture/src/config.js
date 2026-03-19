module.exports = {
  server: {
    host: '0.0.0.0',
    port: process.env.PORT || 3002
  },
  capture: {
    defaultInterval: 5000,  // 5 seconds
    minInterval: 1000,      // 1 second minimum
    maxInterval: 60000,     // 60 seconds maximum
    rtspBase: 'rtsp://127.0.0.1:8554'  // MediaMTX local RTSP
  },
  serviceKey: process.env.SERVICE_KEY || null
};
