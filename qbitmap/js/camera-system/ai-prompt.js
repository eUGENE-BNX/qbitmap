/**
 * AI Vision prompt constants and builder
 * Extracted to avoid circular imports between index ↔ settings / ai-monitoring
 */

export const AI_VISION_PROMPT = `Sen bir acil durum algılama asistanısın. Sana verilen görüntüyü analiz et ve sadece JSON formatında yanıt ver.

Tespit etmen gereken durumlar:
- Düşmüş kişi (yerde yatan, bilinçsiz görünen)
- Yangın veya duman
- Kavga veya şiddet
- Panik hali veya kaçış
- Tıbbi acil durum belirtileri

JSON formatı:
{
  "alarm": true/false,
  "confidence": 0-100,
  "tasvir": "kısa açıklama"
}

Önemli:
- Normal aktiviteler için alarm: false
- Sadece gerçek acil durumlar için alarm: true
- Emin değilsen düşük confidence ver
- Yanıt SADECE JSON olmalı, başka metin yok`;

/**
 * Build AI prompt from structured detection rules (mirrors AI_VISION_PROMPT structure)
 */
export function buildPromptFromRules(rules) {
  const enabled = (rules || []).filter(r => r.text?.trim());
  if (!enabled.length) return AI_VISION_PROMPT;

  // Detection list - same format as global prompt
  let detectionList = '';
  enabled.forEach(r => { detectionList += `- ${r.text.trim()}\n`; });

  // Alarm rules in "Önemli" section
  const alarmItems = enabled.filter(r => r.alarm);
  const reportItems = enabled.filter(r => !r.alarm);

  let alarmRules = '';
  alarmItems.forEach(r => { alarmRules += `- ${r.text.trim()} tespit edersen alarm: true\n`; });
  reportItems.forEach(r => { alarmRules += `- ${r.text.trim()} tespit edersen alarm: false, sadece tasvir yaz\n`; });

  return `Sen bir acil durum algılama asistanısın. Sana verilen görüntüyü analiz et ve sadece JSON formatında yanıt ver.

Tespit etmen gereken durumlar:
${detectionList}
JSON formatı:
{
  "alarm": true/false,
  "confidence": 0-100,
  "tasvir": "kısa açıklama"
}

Önemli:
- Normal aktiviteler için alarm: false
${alarmRules}- Emin değilsen düşük confidence ver
- Yanıt SADECE JSON olmalı, başka metin yok`;
}
