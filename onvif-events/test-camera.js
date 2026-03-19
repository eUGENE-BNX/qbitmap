const { Cam } = require('onvif');

const cam = new Cam({
  hostname: '212.253.82.220',
  port: 2020,
  username: 'camera',
  password: '12345678',
  timeout: 30000,
  preserveAddress: true
}, (err) => {
  if (err) {
    console.error('Connection error:', err.message);
    process.exit(1);
  }

  console.log('Connected to camera!');
  console.log('Device Information:', cam.deviceInformation);
  console.log('\nCapabilities:', JSON.stringify(cam.capabilities, null, 2));
  
  // Check event capabilities
  if (cam.capabilities && cam.capabilities.events) {
    console.log('\nEvent Capabilities:', JSON.stringify(cam.capabilities.events, null, 2));
  }

  process.exit(0);
});
