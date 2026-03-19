const crypto = require('crypto');

const SHARED_SECRET = 'chihuahua7';
const TEST_DEVICE_ID = '0c9ad0f1ec44'; // Example ESP32 MAC

function computeHmac(deviceId) {
  return crypto.createHmac('sha256', SHARED_SECRET).update(deviceId).digest('hex');
}

const token = computeHmac(TEST_DEVICE_ID);
console.log('Test Device ID:', TEST_DEVICE_ID);
console.log('HMAC Token:', token);
console.log('\nCurl command for registration:');
console.log(`curl -X POST http://localhost:3000/api/devices \
  -H "X-Device-ID: ${TEST_DEVICE_ID}" \
  -H "X-Device-Token: ${token}"`);

console.log('\n\nCurl command for frame upload (use a real JPEG file):');
console.log(`curl -X POST http://localhost:3000/api/devices/${TEST_DEVICE_ID}/frame \
  -H "X-Device-ID: ${TEST_DEVICE_ID}" \
  -H "X-Device-Token: ${token}" \
  -H "X-Config-Version: 0" \
  -H "Content-Type: image/jpeg" \
  --data-binary "@/path/to/image.jpg"`);

console.log('\n\nCurl command to get camera info:');
console.log(`curl http://localhost:3000/api/devices/${TEST_DEVICE_ID} \
  -H "X-Device-ID: ${TEST_DEVICE_ID}" \
  -H "X-Device-Token: ${token}"`);
