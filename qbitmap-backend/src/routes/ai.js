/**
 * AI Detection Proxy Routes
 * Proxy requests to vLLM API with rate limiting
 */

const { fetchWithTimeout } = require('../utils/fetch-timeout');
const { checkFeatureLimit, incrementUsage } = require('../middleware/limits');
const { validateBody, aiAnalyzeSchema } = require('../utils/validation');
const { getVllmUrl, getVllmApiKey, getModelName } = require('../utils/ai-config');
const { authHook } = require('../utils/jwt');

// Transform request from Ollama format to vLLM/OpenAI format
async function transformRequest(body) {
  const { prompt, images, options } = body;
  const model = await getModelName();

  // Pass through max_tokens from frontend (options.num_predict) with sane limits
  const maxTokens = Math.min(Math.max(parseInt(options?.num_predict) || 1024, 256), 4096);
  const temperature = parseFloat(options?.temperature) || undefined;

  // Prepend /no_think to disable Qwen3 thinking mode for faster responses
  const finalPrompt = `/no_think\n${prompt || ''}`;

  const req = {
    model,
    messages: [{
      role: 'user',
      content: [
        ...(images || []).map(img => ({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${img}` }
        })),
        { type: 'text', text: finalPrompt }
      ]
    }],
    max_tokens: maxTokens
  };

  if (temperature !== undefined) req.temperature = temperature;

  return req;
}

// Transform response from vLLM/OpenAI format to Ollama format
function transformResponse(vllmData) {
  return {
    response: vllmData.choices?.[0]?.message?.content || ''
  };
}

// IP-based rate limiter for abuse prevention
const ipRateLimiter = {
  requests: new Map(), // IP -> { count, resetTime }
  maxRequests: 240,    // max 240 requests per window (supports ~12 concurrent cameras)
  windowMs: 60000,     // 1 minute window

  check(ip) {
    const now = Date.now();
    const record = this.requests.get(ip);

    if (!record || now > record.resetTime) {
      this.requests.set(ip, { count: 1, resetTime: now + this.windowMs });
      return { allowed: true, remaining: this.maxRequests - 1 };
    }

    if (record.count >= this.maxRequests) {
      return { allowed: false, remaining: 0, resetIn: record.resetTime - now };
    }

    record.count++;
    return { allowed: true, remaining: this.maxRequests - record.count };
  },

  // Cleanup old entries every 5 minutes
  cleanup() {
    const now = Date.now();
    for (const [ip, record] of this.requests.entries()) {
      if (now > record.resetTime) {
        this.requests.delete(ip);
      }
    }
  }
};

// User-based rate limiter (per userId)
const userRateLimiter = {
  requests: new Map(),
  maxRequests: 60,
  windowMs: 60000,

  check(userId) {
    const now = Date.now();
    const record = this.requests.get(userId);

    if (!record || now > record.resetTime) {
      this.requests.set(userId, { count: 1, resetTime: now + this.windowMs });
      return { allowed: true, remaining: this.maxRequests - 1 };
    }

    if (record.count >= this.maxRequests) {
      return { allowed: false, remaining: 0, resetIn: record.resetTime - now };
    }

    record.count++;
    return { allowed: true, remaining: this.maxRequests - record.count };
  },

  cleanup() {
    const now = Date.now();
    for (const [id, record] of this.requests.entries()) {
      if (now > record.resetTime) this.requests.delete(id);
    }
  }
};

// Start cleanup interval
setInterval(() => { ipRateLimiter.cleanup(); userRateLimiter.cleanup(); }, 300000);

async function aiRoutes(fastify, options) {
  // All AI routes require authentication
  fastify.addHook('preHandler', authHook);

  /**
   * POST /api/ai/analyze
   * Proxy to vLLM API for image analysis
   * Rate limited: IP (240/min) + User (60/min) + plan-based daily limits
   */
  fastify.post('/analyze', {
    preHandler: [validateBody(aiAnalyzeSchema), async (request, reply) => {
      // 1. IP-based rate limiting (DDoS prevention)
      const ip = request.ip;
      const ipCheck = ipRateLimiter.check(ip);

      if (!ipCheck.allowed) {
        fastify.log.warn({ ip }, '[AI Proxy] IP rate limit exceeded');
        reply.header('Retry-After', Math.ceil(ipCheck.resetIn / 1000));
        return reply.status(429).send({
          error: 'Too many requests',
          message: 'AI analysis rate limit exceeded. Please try again later.',
          retryAfter: Math.ceil(ipCheck.resetIn / 1000)
        });
      }

      // 2. User-based rate limiting
      const userCheck = userRateLimiter.check(request.user.userId);
      if (!userCheck.allowed) {
        fastify.log.warn({ userId: request.user.userId }, '[AI Proxy] User rate limit exceeded');
        reply.header('Retry-After', Math.ceil(userCheck.resetIn / 1000));
        return reply.status(429).send({
          error: 'Too many requests',
          message: 'AI analysis rate limit exceeded. Please try again later.',
          retryAfter: Math.ceil(userCheck.resetIn / 1000)
        });
      }
    }, checkFeatureLimit('ai_analysis')]
  }, async (request, reply) => {
    try {
      fastify.log.info('[AI Proxy] Received analyze request');

      const vllmBody = await transformRequest(request.body);
      const vllmUrl = await getVllmUrl();
      const apiKey = await getVllmApiKey();

      fastify.log.info({ url: vllmUrl, model: vllmBody.model }, '[AI Proxy] Calling vLLM');

      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const response = await fetchWithTimeout(vllmUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(vllmBody)
      }, 60000); // 60s timeout for AI analysis

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        fastify.log.error({ status: response.status, error: errorText }, '[AI Proxy] vLLM API error');
        throw new Error('AI service temporarily unavailable');
      }

      const vllmData = await response.json();
      const data = transformResponse(vllmData);

      fastify.log.info('[AI Proxy] Analysis complete');

      // Increment usage counter
      await incrementUsage(request.user.userId, 'ai_analysis', 1);

      return data;

    } catch (error) {
      fastify.log.error({ error: error.message, stack: error.stack }, '[AI Proxy] Error');
      reply.code(500);
      return {
        error: 'AI analysis failed',
        message: 'AI service is temporarily unavailable. Please try again later.'
      };
    }
  });
}

module.exports = aiRoutes;
