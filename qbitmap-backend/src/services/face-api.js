const { fetchWithTimeout } = require('../utils/fetch-timeout');
const logger = require('../utils/logger').child({ module: 'face-api' });

const FACE_API_URL = process.env.FACE_API_URL || 'https://matcher.qbitwise.com';
const FACE_API_CREDENTIALS = {
  username: process.env.FACE_API_USERNAME,
  password: process.env.FACE_API_PASSWORD
};

// Validate credentials at startup
if (!FACE_API_CREDENTIALS.username || !FACE_API_CREDENTIALS.password) {
  logger.warn('FACE_API_USERNAME and FACE_API_PASSWORD environment variables not set!');
}

let cachedToken = null;
let tokenExpiresAt = null;

/**
 * [BE-003] Login with exponential backoff retry
 */
async function login(retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      logger.info({ attempt, retries }, 'Logging in to Face API');
      const response = await fetchWithTimeout(`${FACE_API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(FACE_API_CREDENTIALS)
      }, 15000); // 15s timeout

      if (!response.ok) {
        throw new Error(`Face API login failed: ${response.status}`);
      }

      const data = await response.json();
      cachedToken = data.token;
      tokenExpiresAt = new Date(data.expiresAt).getTime() - 300000;
      logger.info('Face API login successful');
      return cachedToken;

    } catch (error) {
      if (attempt === retries) {
        logger.error({ err: error, retries }, 'Face API login failed after all retries');
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s...
      const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      logger.warn({ attempt, backoffMs, error: error.message }, 'Face API login attempt failed, retrying');
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}

async function getToken() {
  if (cachedToken && tokenExpiresAt && Date.now() < tokenExpiresAt) return cachedToken;
  return await login();
}

async function callApi(endpoint, method = 'GET', body = null, retry = 0) {
  const token = await getToken();
  const options = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body) options.body = JSON.stringify(body);
  const response = await fetchWithTimeout(`${FACE_API_URL}${endpoint}`, options, 15000);
  if (response.status === 401 && retry === 0) { cachedToken = null; return await callApi(endpoint, method, body, 1); }
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

// Special function for face upload using multipart/form-data
async function addFace(personId, imageBuffer, mimeType = 'image/jpeg') {
  const token = await getToken();

  // Create form data with Blob
  const formData = new FormData();
  formData.append('personId', personId.toString());

  // Create blob from buffer
  const blob = new Blob([imageBuffer], { type: mimeType });
  formData.append('face', blob, 'face.jpg');

  logger.info({ personId, imageSize: imageBuffer.length }, 'Adding face');

  const response = await fetchWithTimeout(`${FACE_API_URL}/person/face/add`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
      // Don't set Content-Type - let fetch set it with boundary for multipart
    },
    body: formData
  }, 30000); // 30s timeout for image upload

  let data;
  try {
    data = await response.json();
  } catch (e) {
    data = { error: 'Failed to parse response' };
  }

  logger.info({ status: response.status }, 'addFace response');

  return { ok: response.ok, status: response.status, data };
}

// Special function for face recognition (1:N search) using multipart/form-data
async function recognizeFace(imageBuffer, mimeType = 'image/jpeg') {
  const token = await getToken();

  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: mimeType });
  formData.append('face', blob, 'face.jpg');

  logger.info({ imageSize: imageBuffer.length }, 'Recognizing face');

  const response = await fetchWithTimeout(`${FACE_API_URL}/person/face/recognize`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  }, 30000); // 30s timeout for face recognition

  let data;
  try {
    data = await response.json();
  } catch (e) {
    data = { error: 'Failed to parse response' };
  }

  logger.info({ status: response.status }, 'recognizeFace response');

  return { ok: response.ok, status: response.status, data };
}

module.exports = {
  createPerson: (name, tag) => callApi('/person/add', 'POST', { firstname: name, lastname: tag, tag }),
  addFace,
  deletePerson: (personId) => callApi(`/person/${personId}`, 'DELETE'),
  recognizeFace
};
