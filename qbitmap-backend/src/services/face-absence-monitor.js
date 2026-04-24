const cron = require('node-cron');
const db = require('./database');
const logger = require('../utils/logger').child({ module: 'face-absence' });

// Absence alarm scheduler.
//
// Every minute we look for rules whose window just closed (end_time fell
// inside the last 90 seconds) and haven't fired yet today. For each, we
// query face_detection_log for matches across all of the owner's cameras
// during the window. Zero matches → fire alarm.
//
// Why 90 seconds? cron wakes up ~every 60s but the tick time can drift
// and the query runs a little after the minute rolls over. 90s is a safe
// overlap; idempotency comes from the UNIQUE (rule_id, window_date) key
// on face_absence_events, so a rule that matches the window on two
// consecutive ticks still fires exactly once.

let task = null;

async function processTick() {
  let wsService;
  try {
    wsService = require('./websocket');
  } catch (_) {
    // WebSocket not wired yet; still do DB work — the client picks up
    // active alarms on reconnect via its initial-state handshake.
  }

  let voiceCallService;
  try {
    voiceCallService = require('./voice-call');
  } catch (_) { /* voice calls are optional */ }

  let rules;
  try {
    rules = await db.getDueAbsenceRules();
  } catch (err) {
    logger.error({ err }, 'Failed to load due absence rules');
    return;
  }
  if (!rules.length) return;

  for (const rule of rules) {
    try {
      // Compute the UTC boundaries of today's window. We store TIME fields
      // without a timezone, so CURRENT_DATE + rule.start_time is interpreted
      // in the server's local tz. That matches how end_time was compared
      // against CURTIME() in the SELECT — keep the same semantics here.
      const today = new Date();
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, '0');
      const d = String(today.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${d}`;
      const startIso = `${dateStr} ${rule.start_time}`;
      const endIso = `${dateStr} ${rule.end_time}`;

      const count = await db.countFaceDetectionsForUser(
        rule.user_face_id,
        rule.user_id,
        startIso,
        endIso
      );

      if (count > 0) {
        // Seen at least once; record an event row anyway so we don't keep
        // re-scanning the same window on every tick within the 90s overlap.
        await db.recordAbsenceEvent(rule.id);
        continue;
      }

      const recorded = await db.recordAbsenceEvent(rule.id);
      if (!recorded) continue; // someone else got here first

      // Look up the face metadata for the broadcast payload. Doing this
      // after recordAbsenceEvent means even if the DB read fails later,
      // we don't double-fire.
      const fullRule = await db.getFaceAbsenceRuleById(rule.id, rule.user_id);
      const faceName = fullRule?.face_name || 'Unknown';
      const faceImageUrl = fullRule?.face_image_url || null;

      logger.warn({
        ruleId: rule.id, userId: rule.user_id, faceName,
        window: `${rule.start_time}-${rule.end_time}`
      }, 'Absence alarm fired');

      if (wsService) {
        wsService.sendToUser(rule.user_id, {
          type: 'face_absence_alarm',
          payload: {
            ruleId: rule.id,
            faceName,
            faceImageUrl,
            label: rule.label || null,
            startTime: rule.start_time,
            endTime: rule.end_time,
            triggeredAt: new Date().toISOString()
          }
        });
      }

      // [PWA-01] Fire a Web Push in parallel with the WS broadcast so
      // users whose tab is closed still get the alarm. Topic keys on the
      // rule id so the browser coalesces duplicates if multiple cameras
      // trigger the same rule back-to-back.
      try {
        const pushService = require('./push');
        const config = require('../config');
        const absFaceUrl = faceImageUrl
          ? (/^https?:\/\//i.test(faceImageUrl)
              ? faceImageUrl
              : `${config.frontend.url}${faceImageUrl.startsWith('/') ? '' : '/'}${faceImageUrl}`)
          : undefined;
        await pushService.sendToUser(rule.user_id, {
          title: `${faceName} kamerada görünmedi`,
          body: `${rule.start_time}-${rule.end_time} aralığında hareket yok`,
          tag: `absence-${rule.id}`,
          topic: `absence-${rule.id}`,
          urgency: 'high',
          navigate: '/',
          icon: absFaceUrl,
          image: absFaceUrl,
          suppressIfVisible: true,
        });
      } catch (err) {
        logger.warn({ err: err.message, ruleId: rule.id }, 'push dispatch failed (non-fatal)');
      }

      if (rule.voice_call_enabled && voiceCallService) {
        setImmediate(async () => {
          try {
            // Voice call requires a deviceId; pick the user's first
            // face-detection camera as the representative device. If the
            // user has none, skip silently.
            const cameras = await db.getActiveFaceDetectionCameras(rule.user_id);
            const representative = cameras[0];
            if (!representative) return;
            await voiceCallService.initiateCallForFace(
              representative.device_id,
              representative.name || representative.device_id,
              `${faceName} (yoklama)`
            );
          } catch (err) {
            logger.error({ err, ruleId: rule.id }, 'Absence voice call failed');
          }
        });
      }
    } catch (err) {
      logger.error({ err, ruleId: rule.id }, 'Absence rule processing failed');
    }
  }
}

function start() {
  if (task) return;
  // 5-field cron fires on the top of every minute. The getDueAbsenceRules
  // query looks 90s back so a tick that lands a few seconds late still
  // catches a window that closed at the start of the minute.
  task = cron.schedule('* * * * *', () => {
    processTick().catch(err => logger.error({ err }, 'Absence tick crashed'));
  });
  logger.info('Face absence monitor started (cron: every minute)');
}

function stop() {
  if (task) { task.stop(); task = null; }
}

module.exports = { start, stop, processTick };
