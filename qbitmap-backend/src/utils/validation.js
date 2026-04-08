/**
 * Zod validation schemas for API input validation
 * Prevents injection attacks and ensures type safety
 */

const { z } = require('zod');

// ==================== MONITORING SCHEMAS ====================

const monitoringToggleSchema = z.object({
  enabled: z.boolean()
});

const createAlarmSchema = z.object({
  tasvir: z.string().max(2000).optional(),
  detected_objects: z.array(z.string().max(100)).max(50).optional(), // Limit item length and count
  confidence: z.number().min(0).max(1).optional(),
  timestamp: z.string().max(50).optional(),
  snapshot: z.string().max(500_000).optional()  // Base64 image for alarm display (broadcast only, not stored in DB)
}).strict(); // Only allow defined fields

// ==================== ONVIF SCHEMAS ====================

const addOnvifCameraSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  host: z.string().min(1).max(255),
  port: z.union([z.number().int().min(1).max(65535), z.string().regex(/^\d+$/)]),
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200)
});

const linkCameraSchema = z.object({
  qbitmapCameraId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  onvifCameraId: z.string().min(1).max(100),
  templateId: z.number().int().positive().optional()
});

const webhookEventSchema = z.object({
  onvifCameraId: z.string().min(1).max(100),
  eventType: z.string().min(1).max(100),
  eventState: z.union([z.boolean(), z.number()]),
  eventData: z.record(z.unknown()).optional()
}).refine(
  (data) => !data.eventData || JSON.stringify(data.eventData).length < 10000,
  { message: 'eventData too large (max 10KB)' }
);

// ==================== RTSP CAMERA SCHEMAS ====================

const addRtspCameraSchema = z.object({
  name: z.string().min(1).max(200),
  rtsp_url: z.string()
    .min(10)
    .max(500)
    .regex(/^rtsp:\/\//, 'URL must start with rtsp://'),
  onvif_port: z.number().int().min(1).max(65535).default(2020),
  enable_onvif: z.boolean().default(true),
  onvif_template_id: z.number().int().positive().optional()
});

// ==================== ADMIN OVERRIDE SCHEMAS ====================

const userOverridesSchema = z.object({
  max_cameras: z.number().int().min(0).max(1000).optional(),
  max_recordings_per_camera: z.number().int().min(0).max(10000).optional(),
  voice_control_enabled: z.boolean().optional(),
  face_login_enabled: z.boolean().optional(),
  public_sharing_enabled: z.boolean().optional(),
  ai_analysis_enabled: z.boolean().optional(),
  max_shared_cameras: z.number().int().min(0).max(1000).optional()
}).strict();

// ==================== ADMIN SCHEMAS ====================

const adminUpdateUserSchema = z.object({
  plan_id: z.number().int().positive().optional(),
  role: z.enum(['user', 'admin']).optional(),
  is_active: z.boolean().optional(),
  notes: z.string().max(5000).optional()
}).strict();

const adminPlanSchema = z.object({
  name: z.string().min(1).max(100),
  display_name: z.string().min(1).max(200),
  max_cameras: z.number().int().min(0).max(1000).optional(),
  max_whep_cameras: z.number().int().min(0).max(1000).optional(),
  max_recordings_per_camera: z.number().int().min(0).max(10000).optional(),
  voice_control_enabled: z.boolean().optional(),
  face_login_enabled: z.boolean().optional(),
  public_sharing_enabled: z.boolean().optional(),
  ai_analysis_enabled: z.boolean().optional(),
  ai_daily_limit: z.number().int().min(0).max(100000).optional(),
  max_shared_cameras: z.number().int().min(0).max(1000).optional()
}).passthrough();

// ==================== AI SCHEMAS ====================

const aiAnalyzeSchema = z.object({
  prompt: z.string().min(1).max(10000),
  images: z.array(z.string().max(10_000_000)).max(4).optional(),
  options: z.object({
    num_predict: z.number().int().min(256).max(4096).optional(),
    temperature: z.number().min(0).max(2).optional()
  }).optional()
}).passthrough();

// ==================== SETTINGS SCHEMAS ====================

const cameraSettingsSchema = z.object({
  // Allow any settings structure but limit size
}).passthrough().refine(
  (data) => JSON.stringify(data).length < 50000,
  { message: 'Settings too large' }
);

// ==================== DEVICE ID VALIDATION ====================

const deviceIdSchema = z.string()
  .min(3)
  .max(50)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid device ID format');

// ==================== VALIDATION HELPER ====================

/**
 * Validate request body against schema
 * @param {object} body - Request body
 * @param {z.ZodSchema} schema - Zod schema
 * @returns {{ success: boolean, data?: any, error?: string }}
 */
function validate(body, schema) {
  const result = schema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
  };
}

/**
 * Fastify preValidation hook factory
 * @param {z.ZodSchema} schema - Zod schema for body validation
 */
function validateBody(schema) {
  return async (request, reply) => {
    const result = validate(request.body, schema);
    if (!result.success) {
      return reply.code(400).send({ error: 'Validation failed', details: result.error });
    }
    request.body = result.data; // Use sanitized data
  };
}

/**
 * Resolve a relative file path safely within the project root.
 * Prevents path traversal attacks (e.g. ../../etc/passwd).
 * Returns null if the resolved path escapes the allowed directory.
 */
const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '../..');

function safePath(relativePath, allowedSubdir = '') {
  if (!relativePath || typeof relativePath !== 'string') return null;
  const allowedDir = path.resolve(PROJECT_ROOT, allowedSubdir);
  const resolved = path.resolve(PROJECT_ROOT, relativePath);
  if (!resolved.startsWith(allowedDir + path.sep) && resolved !== allowedDir) return null;
  return resolved;
}

/**
 * Parse and validate a positive integer route param.
 * Returns the integer or null if invalid.
 * Use: const id = parseId(request.params.cameraId);
 *      if (id === null) return reply.code(400).send({ error: 'Invalid id' });
 */
function parseId(v) {
  if (v === undefined || v === null || v === '') return null;
  // Reject anything that isn't pure digits to avoid '12abc' → 12 quirk
  if (typeof v === 'string' && !/^\d+$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

module.exports = {
  // Schemas
  userOverridesSchema,
  monitoringToggleSchema,
  createAlarmSchema,
  addOnvifCameraSchema,
  linkCameraSchema,
  webhookEventSchema,
  addRtspCameraSchema,
  cameraSettingsSchema,
  deviceIdSchema,
  adminUpdateUserSchema,
  adminPlanSchema,
  aiAnalyzeSchema,
  // Helpers
  validate,
  validateBody,
  safePath,
  parseId
};
