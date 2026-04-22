// Probe Tapo C236 via WAN. Usage:
//   ONVIF_HOST=212.253.82.220 ONVIF_PORT=12020 ONVIF_USER=qbitc236 ONVIF_PASS=c236c236 \
//     node test-c236.js
// Falls back to the values embedded here for local runs.
const { Cam } = require('onvif');

const HOST = process.env.ONVIF_HOST || '212.253.82.220';
const PORT = parseInt(process.env.ONVIF_PORT || '2020', 10);
const USER = process.env.ONVIF_USER || 'qbitc236';
const PASS = process.env.ONVIF_PASS || 'c236c236';

console.log(`Probing ${HOST}:${PORT} as ${USER}...`);

const cam = new Cam({
  hostname: HOST,
  port: PORT,
  username: USER,
  password: PASS,
  timeout: 20000,
  preserveAddress: true
}, (err) => {
  if (err) {
    console.error('\n❌ Connection failed:', err.message);
    console.error('Tips:');
    console.error('  • Check the external ONVIF port — RTSP is 13554, ONVIF is usually a different port.');
    console.error('  • Confirm the camera account is created in the Tapo app (NOT your Tapo email/password).');
    console.error('  • Confirm port 2020 (internal) is forwarded to some external port on the router.');
    process.exit(1);
  }

  console.log('\n✅ Connected.');
  console.log('\n— Device info —');
  console.log(cam.deviceInformation);

  console.log('\n— Capabilities (PTZ, events) —');
  console.log('PTZ capability:', !!(cam.capabilities && cam.capabilities.PTZ));
  console.log('events capability:', !!(cam.capabilities && cam.capabilities.events));

  console.log('\n— Profiles —');
  const profiles = Array.isArray(cam.profiles) ? cam.profiles : [];
  for (const p of profiles) {
    const token = (p.$ && p.$.token) || p.token;
    const hasPtz = !!p.PTZConfiguration;
    console.log(`  profile: token=${token} name=${p.name || '(no name)'} ptz=${hasPtz}`);
  }
  console.log('defaultProfile.token:', cam.defaultProfile && ((cam.defaultProfile.$ && cam.defaultProfile.$.token) || cam.defaultProfile.token));

  // Try a PTZ sanity check: tiny pan-right then immediate stop.
  // Trust profile-level PTZConfiguration; Tapo firmwares advertise
  // top-level PTZ=false yet accept continuousMove just fine.
  const anyPtzProfile = (cam.profiles || []).some(p => p && p.PTZConfiguration);
  if (anyPtzProfile) {
    console.log('\n— PTZ smoke test (brief right-pan then stop) —');
    cam.continuousMove({ x: 0.3, y: 0, zoom: 0, onvifTimeout: 'PT1S' }, (moveErr) => {
      if (moveErr) {
        console.error('  continuousMove failed:', moveErr.message);
        process.exit(2);
      }
      console.log('  continuousMove OK');
      setTimeout(() => {
        cam.stop({ panTilt: true, zoom: true }, (stopErr) => {
          if (stopErr) {
            console.error('  stop failed:', stopErr.message);
            process.exit(3);
          }
          console.log('  stop OK');
          process.exit(0);
        });
      }, 600);
    });
  } else {
    process.exit(0);
  }
});
