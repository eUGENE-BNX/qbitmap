'use strict';

const config = require('../config');
const db = require('./database');
const logger = require('../utils/logger').child({ module: 'google-places' });

const API_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const FIELD_MASK = 'places.id,places.displayName,places.location,places.primaryType';
const CACHE_TTL_MS = (config.googlePlaces?.cacheTTLDays || 30) * 24 * 60 * 60 * 1000;

const DEFAULT_INCLUDED_TYPES = [
  'restaurant', 'cafe', 'shopping_mall', 'store', 'gas_station',
  'supermarket', 'pharmacy', 'bank', 'hotel', 'bar', 'museum',
  'mosque', 'church', 'school', 'hospital', 'gym', 'park',
  'airport', 'train_station', 'bus_station'
];

const DEFAULT_FALLBACK_TYPES = [
  'shopping_mall', 'supermarket', 'gas_station', 'park', 'bank'
];

// Round to 4 decimal places (~11m precision) for cache cell key
function roundCoord(val) {
  return Math.round(val * 10000) / 10000;
}

async function getSettingsOrDefaults() {
  const [typesRaw, radiusRaw, maxResultsRaw, fallbackRaw] = await Promise.all([
    db.getSystemSetting('places_included_types'),
    db.getSystemSetting('places_radius'),
    db.getSystemSetting('places_max_results'),
    db.getSystemSetting('places_fallback_types')
  ]);

  let includedTypes = DEFAULT_INCLUDED_TYPES;
  if (typesRaw) {
    try { includedTypes = JSON.parse(typesRaw); } catch {}
  }

  let fallbackTypes = DEFAULT_FALLBACK_TYPES;
  if (fallbackRaw) {
    try { fallbackTypes = JSON.parse(fallbackRaw); } catch {}
  }

  const radius = parseInt(radiusRaw) || config.googlePlaces?.defaultRadius || 30;
  const maxResultCount = parseInt(maxResultsRaw) || config.googlePlaces?.maxResultCount || 10;

  return { includedTypes, fallbackTypes, radius, maxResultCount };
}

async function callPlacesAPI(apiKey, lat, lng, radius, maxResultCount, types) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK
    },
    body: JSON.stringify({
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: radius
        }
      },
      includedTypes: types,
      maxResultCount,
      rankPreference: 'DISTANCE'
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    logger.error({ status: response.status, body: errText }, 'Google Places API error');
    return null;
  }

  const data = await response.json();
  return (data.places || []).map(p => ({
    googlePlaceId: p.id,
    displayName: p.displayName?.text || 'Unknown',
    formattedAddress: null,
    lat: p.location?.latitude || lat,
    lng: p.location?.longitude || lng,
    types: p.primaryType ? [p.primaryType] : [],
    businessStatus: null,
    rating: null,
    userRatingsTotal: 0
  }));
}

async function getNearbyPlaces(lat, lng) {
  const cellLat = roundCoord(lat);
  const cellLng = roundCoord(lng);
  const { includedTypes, fallbackTypes, radius, maxResultCount } = await getSettingsOrDefaults();

  // 1. Check cache
  const cached = await db.getPlacesCacheCell(cellLat, cellLng, radius);
  if (cached && (Date.now() - new Date(cached.queried_at).getTime()) < CACHE_TTL_MS) {
    const places = await db.getPlacesForCell(cached.id);
    logger.debug({ cellLat, cellLng, count: places.length }, 'Places cache hit');
    return places;
  }

  // 2. Cache miss or expired - call Google Places API
  const apiKey = config.googlePlaces?.apiKey;
  if (!apiKey || apiKey === 'dev-google-places-key') {
    logger.warn('Google Places API key not configured');
    return cached ? await db.getPlacesForCell(cached.id) : [];
  }

  try {
    // Primary search with configured types
    let places = await callPlacesAPI(apiKey, lat, lng, radius, maxResultCount, includedTypes);

    // Fallback: if no results, try fallback types
    if (places && places.length === 0 && fallbackTypes.length > 0) {
      logger.info({ cellLat, cellLng, fallbackTypes }, 'Primary types returned 0 results, trying fallback');
      places = await callPlacesAPI(apiKey, lat, lng, radius, maxResultCount, fallbackTypes);
    }

    if (!places) {
      if (cached) return await db.getPlacesForCell(cached.id);
      return [];
    }

    logger.info({ cellLat, cellLng, radius, count: places.length }, 'Google Places API response');

    // 3. Store in cache and return from DB (with proper IDs)
    const cellId = await db.storePlacesCache(cellLat, cellLng, radius, places);

    return await db.getPlacesForCell(cellId);

  } catch (err) {
    logger.error({ err }, 'Google Places API request failed');
    if (cached) return await db.getPlacesForCell(cached.id);
    return [];
  }
}

module.exports = { getNearbyPlaces };
