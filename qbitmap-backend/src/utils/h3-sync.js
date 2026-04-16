const logger = require('./logger').child({ module: 'h3-sync' });

const H3_SERVICE_URL = process.env.H3_SERVICE_URL;
const H3_SERVICE_KEY = process.env.H3_SERVICE_KEY;

async function notifyH3CameraChange(camera) {
  if (!H3_SERVICE_URL || !H3_SERVICE_KEY) return;

  try {
    const response = await fetch(`${H3_SERVICE_URL}/api/v1/sync/camera`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': H3_SERVICE_KEY
      },
      body: JSON.stringify({
        qbitmap_id: camera.id,
        device_id: camera.device_id,
        lat: camera.lat,
        lng: camera.lng,
        name: camera.name,
        camera_type: camera.camera_type,
        is_public: camera.is_public
      })
    });

    if (!response.ok) {
      logger.warn({ status: response.status, deviceId: camera.device_id }, 'H3 sync returned non-ok');
    }
  } catch (e) {
    logger.warn({ err: e.message, deviceId: camera.device_id }, 'H3 sync failed');
  }
}

async function notifyH3CameraRemove(deviceId) {
  if (!H3_SERVICE_URL || !H3_SERVICE_KEY) return;

  try {
    await fetch(`${H3_SERVICE_URL}/api/v1/sync/camera/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { 'X-Service-Key': H3_SERVICE_KEY }
    });
  } catch (e) {
    logger.warn({ err: e.message, deviceId }, 'H3 sync remove failed');
  }
}

// === Ownership system sync ===

async function notifyH3ContentItem({ itemType, itemId, userId, lat, lng, points }) {
  if (!H3_SERVICE_URL || !H3_SERVICE_KEY) return;

  try {
    const response = await fetch(`${H3_SERVICE_URL}/api/v1/sync/content`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': H3_SERVICE_KEY
      },
      body: JSON.stringify({ itemType, itemId, userId, lat, lng, points })
    });

    if (!response.ok) {
      logger.warn({ status: response.status, itemId }, 'H3 content sync returned non-ok');
    }
  } catch (e) {
    logger.warn({ err: e.message, itemId }, 'H3 content sync failed');
  }
}

async function notifyH3ContentItemRemove(itemId) {
  if (!H3_SERVICE_URL || !H3_SERVICE_KEY) return;

  try {
    await fetch(`${H3_SERVICE_URL}/api/v1/sync/content/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
      headers: { 'X-Service-Key': H3_SERVICE_KEY }
    });
  } catch (e) {
    logger.warn({ err: e.message, itemId }, 'H3 content remove failed');
  }
}

const AVATAR_URL_MAX = 2048;

async function notifyH3UserProfile({ id, displayName, avatarUrl }) {
  if (!H3_SERVICE_URL || !H3_SERVICE_KEY) return;

  const body = { id, displayName };
  if (avatarUrl && avatarUrl.length <= AVATAR_URL_MAX) {
    body.avatarUrl = avatarUrl;
  } else if (avatarUrl) {
    logger.warn({ userId: id, len: avatarUrl.length }, 'Avatar URL exceeds max, syncing profile without avatar');
  }

  try {
    const response = await fetch(`${H3_SERVICE_URL}/api/v1/sync/user-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': H3_SERVICE_KEY
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      logger.warn({ status: response.status, userId: id }, 'H3 user profile sync returned non-ok');
    }
  } catch (e) {
    logger.warn({ err: e.message, userId: id }, 'H3 user profile sync failed');
  }
}

async function notifyH3ItemViews({ itemId, viewCount }) {
  if (!H3_SERVICE_URL || !H3_SERVICE_KEY) return;

  try {
    const response = await fetch(`${H3_SERVICE_URL}/api/v1/sync/item-views`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': H3_SERVICE_KEY
      },
      body: JSON.stringify({ itemId, viewCount })
    });

    if (!response.ok) {
      logger.warn({ status: response.status, itemId }, 'H3 item views sync returned non-ok');
    }
  } catch (e) {
    logger.warn({ err: e.message, itemId }, 'H3 item views sync failed');
  }
}

module.exports = {
  notifyH3CameraChange,
  notifyH3CameraRemove,
  notifyH3ContentItem,
  notifyH3ContentItemRemove,
  notifyH3UserProfile,
  notifyH3ItemViews
};
