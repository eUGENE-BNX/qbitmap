const db = require("../services/database");
const { authHook } = require("../utils/jwt");
const logger = require("../utils/logger").child({ module: "face-absence" });

// Inputs aren't trusted (client-authored rule data); normalize and reject
// anything that would corrupt the schema or silently misfire at scheduling time.
function parseTime(t) {
  if (typeof t !== "string") return null;
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const s = m[3] ? parseInt(m[3], 10) : 0;
  if (h < 0 || h > 23 || min < 0 || min > 59 || s < 0 || s > 59) return null;
  return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function normalizeMask(v) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return 127;
  return n & 0x7f;
}

async function faceAbsenceRoutes(fastify) {
  fastify.addHook("preHandler", authHook);

  fastify.get("/rules", async (request, reply) => {
    const rules = await db.getFaceAbsenceRules(request.user.userId);
    return { rules };
  });

  fastify.post("/rules", async (request, reply) => {
    const body = request.body || {};
    const start = parseTime(body.start_time);
    const end = parseTime(body.end_time);
    if (!start || !end) return reply.code(400).send({ error: "Invalid start_time or end_time (HH:MM)" });
    if (start >= end) return reply.code(400).send({ error: "start_time must be before end_time" });
    if (!body.user_face_id) return reply.code(400).send({ error: "user_face_id required" });

    const result = await db.addFaceAbsenceRule(request.user.userId, {
      user_face_id: parseInt(body.user_face_id, 10),
      label: (body.label || "").toString().slice(0, 255),
      start_time: start,
      end_time: end,
      day_of_week_mask: normalizeMask(body.day_of_week_mask),
      enabled: body.enabled !== false,
      voice_call_enabled: !!body.voice_call_enabled
    });
    if (!result.success) return reply.code(400).send({ error: result.error });

    logger.info({ userId: request.user.userId, ruleId: result.ruleId, face_id: body.user_face_id }, "Absence rule created");

    const rule = await db.getFaceAbsenceRuleById(result.ruleId, request.user.userId);
    return { success: true, rule };
  });

  fastify.patch("/rules/:id", async (request, reply) => {
    const ruleId = parseInt(request.params.id, 10);
    const body = request.body || {};

    const data = {};
    if (body.user_face_id !== undefined) data.user_face_id = parseInt(body.user_face_id, 10);
    if (body.label !== undefined) data.label = (body.label || "").toString().slice(0, 255);
    if (body.start_time !== undefined) {
      const t = parseTime(body.start_time);
      if (!t) return reply.code(400).send({ error: "Invalid start_time" });
      data.start_time = t;
    }
    if (body.end_time !== undefined) {
      const t = parseTime(body.end_time);
      if (!t) return reply.code(400).send({ error: "Invalid end_time" });
      data.end_time = t;
    }
    if (data.start_time && data.end_time && data.start_time >= data.end_time) {
      return reply.code(400).send({ error: "start_time must be before end_time" });
    }
    if (body.day_of_week_mask !== undefined) data.day_of_week_mask = normalizeMask(body.day_of_week_mask);
    if (body.enabled !== undefined) data.enabled = !!body.enabled;
    if (body.voice_call_enabled !== undefined) data.voice_call_enabled = !!body.voice_call_enabled;

    const result = await db.updateFaceAbsenceRule(ruleId, request.user.userId, data);
    if (!result.success) return reply.code(404).send({ error: result.error });

    const rule = await db.getFaceAbsenceRuleById(ruleId, request.user.userId);
    return { success: true, rule };
  });

  fastify.delete("/rules/:id", async (request, reply) => {
    const ruleId = parseInt(request.params.id, 10);
    const result = await db.deleteFaceAbsenceRule(ruleId, request.user.userId);
    if (!result.success) return reply.code(404).send({ error: result.error });
    logger.info({ userId: request.user.userId, ruleId }, "Absence rule deleted");
    return { success: true };
  });
}

module.exports = faceAbsenceRoutes;
