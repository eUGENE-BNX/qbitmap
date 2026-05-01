#!/usr/bin/env node
/**
 * One-time migration: re-push fleet_telemetry_config to every
 * telemetry-enabled vehicle so they pick up newly added fields
 * (e.g. SoftwareUpdateVersion). Tesla stores config per-VIN, so
 * existing vehicles keep the old config until refreshed.
 *
 * Usage (on Server 1 as root): node scripts/refresh-telemetry-config.js
 */

const fs = require('fs');
const https = require('https');

const secretsPath = '/etc/qbitmap/secrets.env';
if (fs.existsSync(secretsPath)) {
  const envContent = fs.readFileSync(secretsPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

const db = require('../src/services/database');
const { decrypt } = require('../src/utils/encryption');

const TELEMETRY_CONFIG_FIELDS = {
  Location: { interval_seconds: 15, minimum_delta: 25 },
  VehicleSpeed: { interval_seconds: 15 },
  GpsHeading: { interval_seconds: 15 },
  Gear: { interval_seconds: 15 },
  BatteryLevel: { interval_seconds: 600 },
  RatedRange: { interval_seconds: 600 },
  InsideTemp: { interval_seconds: 600 },
  OutsideTemp: { interval_seconds: 600 },
  Locked: { interval_seconds: 600 },
  SentryMode: { interval_seconds: 600 },
  TpmsPressureFl: { interval_seconds: 600 },
  TpmsPressureFr: { interval_seconds: 600 },
  TpmsPressureRl: { interval_seconds: 600 },
  TpmsPressureRr: { interval_seconds: 600 },
  Odometer: { interval_seconds: 3600 },
  Version: { interval_seconds: 21600 },
};

function sendToProxy(path, accessToken, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'localhost',
      port: 8443,
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      rejectUnauthorized: false,
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('proxy timeout')); });
    req.write(data);
    req.end();
  });
}

async function main() {
  await db.ensureReady();

  const certPath = process.env.TESLA_TLS_CERT_PATH || '/opt/fleet-telemetry/server.crt';
  const caPem = fs.readFileSync(certPath, 'utf8').trim();

  const [vehicles] = await db.pool.execute(
    `SELECT v.vin, v.display_name, v.tesla_account_id, t.access_token
       FROM tesla_vehicles v
       JOIN tesla_tokens t ON t.tesla_account_id = v.tesla_account_id
      WHERE v.telemetry_enabled = 1 AND t.expires_at > NOW()`
  );

  console.log(`Found ${vehicles.length} telemetry-enabled vehicles with valid tokens`);

  let ok = 0;
  let failed = 0;
  for (const v of vehicles) {
    const accessToken = decrypt(v.access_token);
    const payload = {
      vins: [v.vin],
      config: {
        hostname: 'telemetry.qbitmap.com',
        port: 4443,
        ca: caPem,
        fields: TELEMETRY_CONFIG_FIELDS,
        alert_types: [],
      },
    };
    try {
      const res = await sendToProxy('/api/1/vehicles/fleet_telemetry_config', accessToken, payload);
      if (res.status >= 200 && res.status < 300) {
        ok++;
        console.log(`OK    ${v.vin} (${v.display_name})`);
      } else {
        failed++;
        console.error(`FAIL  ${v.vin} (${v.display_name}) → ${res.status} ${res.body.slice(0, 200)}`);
      }
    } catch (err) {
      failed++;
      console.error(`ERR   ${v.vin} (${v.display_name}) → ${err.message}`);
    }
  }

  console.log(`\nDone. ok=${ok} failed=${failed} total=${vehicles.length}`);
  await db.pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
