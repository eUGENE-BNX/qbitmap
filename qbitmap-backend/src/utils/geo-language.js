/**
 * Coordinate → primary local language resolver.
 *
 * Strategy: Google Geocoding reverse-lookup gives us both country and
 * administrative_area_level_1 in a single call. We cache the result in DB by
 * a quantized lat/lng cell so subsequent messages from the same area cost
 * nothing. Country mapping handles ~all single-language countries; subdivision
 * map handles the multilingual ones (CH, BE, CA, ES, IN, FI, ...).
 */

const config = require('../config');
const db = require('../services/database');
const logger = require('./logger').child({ module: 'geo-language' });

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const FETCH_TIMEOUT_MS = 5000;

// Quantize coords to ~36km cells (1 decimal ≈ 11km, we use 0.25° steps).
function cellKey(lat, lng) {
  const q = (v) => Math.round(v * 4) / 4;
  return `${q(lat).toFixed(2)},${q(lng).toFixed(2)}`;
}

// Country (ISO-3166-1 alpha-2) → primary BCP47-ish language code.
const COUNTRY_LANG = {
  TR: 'tr', DE: 'de', AT: 'de', LI: 'de',
  GB: 'en', US: 'en', IE: 'en', AU: 'en', NZ: 'en', ZA: 'en',
  FR: 'fr', MC: 'fr', SN: 'fr', CI: 'fr',
  IT: 'it', SM: 'it', VA: 'it',
  ES: 'es', MX: 'es', AR: 'es', CL: 'es', CO: 'es', PE: 'es', VE: 'es',
  PT: 'pt', BR: 'pt', AO: 'pt', MZ: 'pt',
  NL: 'nl', SR: 'nl',
  RU: 'ru', BY: 'ru', KZ: 'ru', KG: 'ru',
  UA: 'uk',
  PL: 'pl', CZ: 'cs', SK: 'sk', HU: 'hu', RO: 'ro', MD: 'ro',
  BG: 'bg', GR: 'el', CY: 'el',
  SE: 'sv', NO: 'no', DK: 'da', IS: 'is',
  HR: 'hr', RS: 'sr', BA: 'bs', SI: 'sl', MK: 'mk', AL: 'sq',
  EE: 'et', LV: 'lv', LT: 'lt',
  JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', HK: 'zh', MO: 'zh',
  TH: 'th', VN: 'vi', ID: 'id', MY: 'ms', SG: 'en', PH: 'en',
  IN: 'hi', PK: 'ur', BD: 'bn', LK: 'si', NP: 'ne',
  IR: 'fa', AF: 'fa', TJ: 'tg',
  SA: 'ar', AE: 'ar', EG: 'ar', JO: 'ar', LB: 'ar', SY: 'ar',
  IQ: 'ar', KW: 'ar', QA: 'ar', BH: 'ar', OM: 'ar', YE: 'ar',
  MA: 'ar', DZ: 'ar', TN: 'ar', LY: 'ar', SD: 'ar',
  IL: 'he',
  ET: 'am', KE: 'sw', TZ: 'sw', UG: 'sw',
  NG: 'en', GH: 'en',
  // Multilingual — handled by subdivision lookup; default below if subdivision missing
  CH: 'de', BE: 'nl', CA: 'en', LU: 'fr', FI: 'fi',
};

// Set of countries where we should consult subdivision before falling back.
const MULTI_LANG_COUNTRIES = new Set(['CH', 'BE', 'CA', 'ES', 'IN', 'FI', 'LU']);

// "{COUNTRY}-{ADMIN1_SHORT}" → lang.
const SUBDIVISION_LANG = {
  // Switzerland (cantons)
  'CH-GE': 'fr', 'CH-VD': 'fr', 'CH-NE': 'fr', 'CH-JU': 'fr', 'CH-FR': 'fr', 'CH-VS': 'fr',
  'CH-TI': 'it',
  'CH-ZH': 'de', 'CH-BE': 'de', 'CH-LU': 'de', 'CH-UR': 'de', 'CH-SZ': 'de',
  'CH-OW': 'de', 'CH-NW': 'de', 'CH-GL': 'de', 'CH-ZG': 'de', 'CH-SO': 'de',
  'CH-BS': 'de', 'CH-BL': 'de', 'CH-SH': 'de', 'CH-AR': 'de', 'CH-AI': 'de',
  'CH-SG': 'de', 'CH-GR': 'de', 'CH-AG': 'de', 'CH-TG': 'de',
  // Belgium
  'BE-VLG': 'nl', 'BE-WAL': 'fr', 'BE-BRU': 'fr',
  // Canada
  'CA-QC': 'fr',
  'CA-ON': 'en', 'CA-BC': 'en', 'CA-AB': 'en', 'CA-MB': 'en', 'CA-SK': 'en',
  'CA-NS': 'en', 'CA-NB': 'en', 'CA-NL': 'en', 'CA-PE': 'en',
  'CA-YT': 'en', 'CA-NT': 'en', 'CA-NU': 'en',
  // Spain
  'ES-CT': 'ca', 'ES-IB': 'ca', 'ES-VC': 'ca',
  'ES-PV': 'eu', 'ES-NC': 'eu',
  'ES-GA': 'gl',
  // India (major regional languages)
  'IN-TN': 'ta', 'IN-KL': 'ml', 'IN-WB': 'bn', 'IN-MH': 'mr', 'IN-KA': 'kn',
  'IN-AP': 'te', 'IN-TG': 'te', 'IN-PB': 'pa', 'IN-GJ': 'gu', 'IN-OR': 'or',
  'IN-AS': 'as',
  // Finland
  'FI-01': 'sv', // Åland
};

const LANG_DISPLAY_NAME = {
  tr: 'Turkish', en: 'English', de: 'German', fr: 'French', it: 'Italian',
  es: 'Spanish', pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', uk: 'Ukrainian',
  pl: 'Polish', cs: 'Czech', sk: 'Slovak', hu: 'Hungarian', ro: 'Romanian',
  bg: 'Bulgarian', el: 'Greek', sv: 'Swedish', no: 'Norwegian', da: 'Danish',
  is: 'Icelandic', hr: 'Croatian', sr: 'Serbian', bs: 'Bosnian', sl: 'Slovenian',
  mk: 'Macedonian', sq: 'Albanian', et: 'Estonian', lv: 'Latvian', lt: 'Lithuanian',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', th: 'Thai', vi: 'Vietnamese',
  id: 'Indonesian', ms: 'Malay', hi: 'Hindi', ur: 'Urdu', bn: 'Bengali',
  si: 'Sinhala', ne: 'Nepali', fa: 'Persian', tg: 'Tajik',
  ar: 'Arabic', he: 'Hebrew', am: 'Amharic', sw: 'Swahili',
  ta: 'Tamil', ml: 'Malayalam', mr: 'Marathi', kn: 'Kannada', te: 'Telugu',
  pa: 'Punjabi', gu: 'Gujarati', or: 'Odia', as: 'Assamese',
  ca: 'Catalan', eu: 'Basque', gl: 'Galician', fi: 'Finnish',
};

function languageDisplayName(code) {
  return LANG_DISPLAY_NAME[code] || 'English';
}

async function reverseGeocode(lat, lng) {
  const apiKey = config.googlePlaces?.apiKey;
  if (!apiKey) return null;

  const url = `${GEOCODE_URL}?latlng=${lat},${lng}&result_type=country|administrative_area_level_1&key=${apiKey}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.status !== 'OK' || !Array.isArray(data.results)) return null;

    let country = null;
    let subdivision = null;
    for (const result of data.results) {
      for (const c of (result.address_components || [])) {
        if (!country && c.types?.includes('country')) country = c.short_name;
        if (!subdivision && c.types?.includes('administrative_area_level_1')) {
          subdivision = c.short_name;
        }
      }
      if (country && subdivision) break;
    }
    return { country, subdivision };
  } catch (err) {
    logger.warn({ err: err.message, lat, lng }, 'Reverse geocode failed');
    return null;
  } finally {
    clearTimeout(t);
  }
}

function pickLang(country, subdivision) {
  if (!country) return 'en';
  if (subdivision && MULTI_LANG_COUNTRIES.has(country)) {
    const key = `${country}-${subdivision}`;
    if (SUBDIVISION_LANG[key]) return SUBDIVISION_LANG[key];
  }
  return COUNTRY_LANG[country] || 'en';
}

/**
 * resolveLanguageForCoords(lat, lng) → { code, name }
 * Uses DB-cached cell lookup; only hits Google API on cache miss.
 */
async function resolveLanguageForCoords(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { code: 'en', name: 'English' };
  }
  const cell = cellKey(lat, lng);

  try {
    const cached = await db.getGeoLangCell(cell);
    if (cached) {
      return { code: cached.lang_code, name: languageDisplayName(cached.lang_code) };
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'geo-lang cache read failed');
  }

  const geo = await reverseGeocode(lat, lng);
  const code = pickLang(geo?.country, geo?.subdivision);

  try {
    await db.upsertGeoLangCell(cell, geo?.country || null, geo?.subdivision || null, code);
  } catch (err) {
    logger.warn({ err: err.message }, 'geo-lang cache write failed');
  }

  return { code, name: languageDisplayName(code) };
}

module.exports = {
  resolveLanguageForCoords,
  languageDisplayName,
  // Exported for tests / translate route whitelist
  COUNTRY_LANG,
  SUBDIVISION_LANG,
  LANG_DISPLAY_NAME,
};
