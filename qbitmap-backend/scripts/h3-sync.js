#!/usr/bin/env node
/**
 * H3 Ownership Sync — one-time migration CLI
 * Usage: node scripts/h3-sync.js
 *
 * Moved from routes/admin.js to avoid having a one-time migration
 * endpoint in the production API surface (ARCH-07).
 */

const fs = require('fs');
const path = require('path');

// Load env from /etc/qbitmap/secrets.env if it exists (for prod)
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
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const db = require('../src/services/database');

async function main() {
  await db.ensureReady();

  const H3_SERVICE_URL = process.env.H3_SERVICE_URL;
  const H3_SERVICE_KEY = process.env.H3_SERVICE_KEY;

  if (!H3_SERVICE_URL || !H3_SERVICE_KEY) {
    console.error('H3_SERVICE_URL or H3_SERVICE_KEY not configured');
    process.exit(1);
  }

  const results = { users: 0, cameras: 0, messages: 0, errors: [] };

  // 1. Sync all user profiles
  const users = await db.getAllUserProfiles();
  const userProfiles = users.map(u => ({ id: u.id, displayName: u.display_name, avatarUrl: u.avatar_url }));
  try {
    const res = await fetch(`${H3_SERVICE_URL}/api/v1/sync/user-profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': H3_SERVICE_KEY },
      body: JSON.stringify({ profiles: userProfiles })
    });
    if (res.ok) results.users = userProfiles.length;
    else results.errors.push('user profiles sync failed: ' + res.status);
  } catch (e) {
    results.errors.push('user profiles sync error: ' + e.message);
  }

  // 2. Sync all cameras (excluding CITY_)
  const cameras = await db.getCamerasForH3Sync();
  const cameraItems = cameras.map(c => ({
    itemType: 'camera', itemId: c.device_id, userId: c.user_id,
    lat: c.lat, lng: c.lng, points: 50
  }));

  // 3. Sync all video/photo messages
  const messages = await db.getVideoMessagesForH3Sync();
  const messageItems = messages.map(m => ({
    itemType: m.media_type === 'photo' ? 'photo' : 'video',
    itemId: m.message_id, userId: m.sender_id,
    lat: m.lat, lng: m.lng, points: m.media_type === 'photo' ? 1 : 5
  }));

  // 4. Purge old video/photo content from H3 (removes orphans from direct DB deletes)
  try {
    const purgeRes = await fetch(`${H3_SERVICE_URL}/api/v1/sync/content-messages`, {
      method: 'DELETE',
      headers: { 'X-Service-Key': H3_SERVICE_KEY }
    });
    if (!purgeRes.ok) results.errors.push('content purge failed: ' + purgeRes.status);
  } catch (e) {
    results.errors.push('content purge error: ' + e.message);
  }

  // 5. Bulk sync all content items (fresh insert after purge)
  const allItems = [...cameraItems, ...messageItems];
  try {
    const res = await fetch(`${H3_SERVICE_URL}/api/v1/sync/full-content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': H3_SERVICE_KEY },
      body: JSON.stringify({ items: allItems })
    });
    if (res.ok) {
      results.cameras = cameraItems.length;
      results.messages = messageItems.length;
    } else {
      results.errors.push('content sync failed: ' + res.status);
    }
  } catch (e) {
    results.errors.push('content sync error: ' + e.message);
  }

  console.log('H3 Ownership Sync Results:');
  console.log(`  Users synced:    ${results.users}`);
  console.log(`  Cameras synced:  ${results.cameras}`);
  console.log(`  Messages synced: ${results.messages}`);
  if (results.errors.length > 0) {
    console.error('Errors:');
    results.errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  } else {
    console.log('All synced successfully.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
