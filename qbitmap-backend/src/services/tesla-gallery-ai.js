const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { fetchWithTimeout } = require('../utils/fetch-timeout');
const { getVllmUrl, getVllmApiKey, getModelName } = require('../utils/ai-config');
const { downscaleForAi } = require('./photo-ai-queue');
const logger = require('../utils/logger').child({ module: 'tesla-gallery-ai' });

const TIMEOUT_MS = 60000;
const GENERIC_REJECT_MSG = "Lütfen Tesla'nızın gözüktüğü bir fotoğraf çekin.";

const STRICT_TESLA_PROMPT = `You are a strict visual verification system for a Tesla-owner vehicle gallery.

Your only task is to decide whether the uploaded image is allowed in a Tesla vehicle gallery.

The image is allowed ONLY if all conditions are true:

1. A real passenger vehicle is clearly visible.
2. The main subject of the image is very likely a Tesla vehicle.
3. The image shows enough exterior evidence to identify the vehicle as Tesla.
4. The image is a real photo, not a render, drawing, AI-generated image, poster, advertisement, screenshot, toy car, or miniature.
5. The Tesla is not tiny, hidden, heavily cropped, heavily blurred, too dark, or obstructed.
6. Interior-only photos are not enough unless Tesla identity is extremely clear.
7. Photos showing only a logo, steering wheel, dashboard screen, wheel, charger, key card, license plate, or small detail are not enough.
8. If another brand is visible and the Tesla is not clearly the main subject, reject.
9. If the vehicle brand is uncertain, reject.
10. When in doubt, reject.

Be conservative. This is a gatekeeper system, not a captioning system.

Accepted examples:
- Clear exterior photo of Tesla Model 3, Model Y, Model S, Model X, Cybertruck, or Roadster.
- Tesla parked, driving, charging, or photographed from front, side, rear, or three-quarter angle.
- Tesla with people nearby, as long as the Tesla is clearly the main subject.

Rejected examples:
- BMW, Mercedes, Audi, Togg, BYD, Hyundai, Toyota, Porsche, or any non-Tesla vehicle.
- Generic electric car where the brand cannot be confidently identified.
- Screenshot from Tesla app, website, marketplace, Instagram, YouTube, or advertisement.
- AI-generated Tesla image, 3D render, wallpaper, poster, toy, miniature, or drawing.
- Close-up of only Tesla logo, screen, steering wheel, charger, wheel, or key card.
- Blurry, dark, cropped, obstructed, distant, or low-quality image.
- Multiple cars where Tesla is not clearly the main subject.

Return ONLY valid JSON.
Do not use markdown.
Do not add any explanation outside JSON.

JSON schema:

{
  "allowed": true or false,
  "decision": "accept" or "reject",
  "confidence": 0.0 to 1.0,
  "vehicle_present": true or false,
  "is_real_photo": true or false,
  "tesla_likely": true or false,
  "tesla_model_guess": "Model 3" | "Model Y" | "Model S" | "Model X" | "Cybertruck" | "Roadster" | "Unknown",
  "main_subject_is_tesla": true or false,
  "image_quality_ok": true or false,
  "rejection_reason_tr": "none" or short Turkish reason,
  "user_message_tr": short Turkish message for the uploader
}

Decision rules:
- allowed must be true only when decision is "accept".
- If confidence is below 0.85, reject.
- If vehicle_present is false, reject.
- If is_real_photo is false, reject.
- If tesla_likely is false, reject.
- If main_subject_is_tesla is false, reject.
- If image_quality_ok is false, reject.
- If the image appears to be a screenshot, advertisement, render, AI-generated image, drawing, toy, miniature, or poster, reject.
- rejection_reason_tr must be "none" only when accepted.
- user_message_tr should be friendly and short.`;

function tryParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // vLLM occasionally wraps JSON in code fences despite the instruction
    const fenced = text.match(/\{[\s\S]*\}/);
    if (fenced) {
      try { return JSON.parse(fenced[0]); } catch { return null; }
    }
    return null;
  }
}

async function verifyTeslaImage(buffer) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const tmpSrc = path.join(os.tmpdir(), `tesla_in_${nonce}.jpg`);
  let tmpScaled = null;

  try {
    await fsp.writeFile(tmpSrc, buffer);
    tmpScaled = await downscaleForAi(tmpSrc);
    const scaledBuf = await fsp.readFile(tmpScaled);
    const b64 = scaledBuf.toString('base64');

    const model = await getModelName();
    const vllmUrl = await getVllmUrl();
    const apiKey = await getVllmApiKey();

    const body = {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
          { type: 'text', text: `/no_think\n${STRICT_TESLA_PROMPT}` }
        ]
      }],
      max_tokens: 512
    };

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetchWithTimeout(vllmUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }, TIMEOUT_MS);

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logger.error({ status: res.status, body: txt.slice(0, 300) }, 'vLLM error');
      return { ok: false, user_message_tr: GENERIC_REJECT_MSG, transient: true };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    logger.info({ contentSample: content.slice(0, 300) }, 'vLLM response');

    const r = tryParseJson(content);
    if (!r || typeof r !== 'object') {
      return { ok: false, user_message_tr: GENERIC_REJECT_MSG };
    }

    const ok =
      r.allowed === true &&
      r.decision === 'accept' &&
      typeof r.confidence === 'number' &&
      r.confidence >= 0.85 &&
      r.vehicle_present === true &&
      r.is_real_photo === true &&
      r.tesla_likely === true &&
      r.main_subject_is_tesla === true &&
      r.image_quality_ok === true &&
      r.rejection_reason_tr === 'none';

    if (ok) {
      return { ok: true, confidence: r.confidence };
    }

    return { ok: false, user_message_tr: GENERIC_REJECT_MSG, raw: r };
  } catch (err) {
    logger.error({ err: err.message }, 'verifyTeslaImage failed');
    return { ok: false, user_message_tr: GENERIC_REJECT_MSG, transient: true };
  } finally {
    fsp.unlink(tmpSrc).catch(() => {});
    if (tmpScaled) fsp.unlink(tmpScaled).catch(() => {});
  }
}

module.exports = { verifyTeslaImage };
