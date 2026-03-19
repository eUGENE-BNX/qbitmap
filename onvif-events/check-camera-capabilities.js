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
  console.log('Device Information:', JSON.stringify(cam.deviceInformation, null, 2));
  console.log('\nCapabilities:', JSON.stringify(cam.capabilities, null, 2));

  // Get services
  cam.getServices(true, (err, services) => {
    if (err) {
      console.error('Failed to get services:', err.message);
    } else {
      console.log('\nServices:', JSON.stringify(services, null, 2));
    }

    // Try to get event properties
    if (cam.events) {
      console.log('\nEvent service available');
      cam.getEventProperties((err, props) => {
        if (err) {
          console.error('Failed to get event properties:', err.message);
        } else {
          console.log('\nEvent Properties:', JSON.stringify(props, null, 2));
        }
        process.exit(0);
      });
    } else {
      console.log('\nNo event service available');
      process.exit(0);
    }
  });
});
