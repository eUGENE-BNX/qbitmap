/**
 * AI Detection Proxy Routes
 * Proxy requests to vLLM API with rate limiting
 */

const { fetchWithTimeout } = require('../utils/fetch-timeout');
const { checkFeatureLimit, incrementUsage } = require('../middleware/limits');
const { validateBody, aiAnalyzeSchema } = require('../utils/validation');
const { getVllmUrl, getModelName } = require('../utils/ai-config');

// Transform request from Ollama format to vLLM/OpenAI format
async function transformRequest(body) {
  const { prompt, images, options } = body;
  const model = await getModelName();

  // Pass through max_tokens from frontend (options.num_predict) with sane limits
  const maxTokens = Math.min(Math.max(parseInt(options?.num_predict) || 1024, 256), 4096);
  const temperature = parseFloat(options?.temperature) || undefined;

  const req = {
    model,
    messages: [{
      role: 'user',
      content: [
        ...(images || []).map(img => ({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${img}` }
        })),
        { type: 'text', text: prompt || '' }
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

// Start cleanup interval
setInterval(() => ipRateLimiter.cleanup(), 300000);

async function aiRoutes(fastify, options) {
  /**
   * POST /api/ai/analyze
   * Proxy to vLLM API for image analysis
   * Rate limited: 30 requests/minute per IP + plan-based daily limits
   */
  fastify.post('/analyze', {
    preHandler: [validateBody(aiAnalyzeSchema), async (request, reply) => {
      // 1. IP-based rate limiting (abuse prevention)
      const ip = request.ip || request.headers['x-forwarded-for'] || 'unknown';
      const rateCheck = ipRateLimiter.check(ip);

      if (!rateCheck.allowed) {
        fastify.log.warn({ ip }, '[AI Proxy] Rate limit exceeded');
        reply.header('Retry-After', Math.ceil(rateCheck.resetIn / 1000));
        return reply.status(429).send({
          error: 'Too many requests',
          message: 'AI analysis rate limit exceeded. Please try again later.',
          retryAfter: Math.ceil(rateCheck.resetIn / 1000)
        });
      }

      // 2. Plan-based limit check (if authenticated)
      if (request.user?.id) {
        const limitCheck = await checkFeatureLimit('ai_analysis');
        await limitCheck(request, reply);
      }
    }]
  }, async (request, reply) => {
    try {
      fastify.log.info('[AI Proxy] Received analyze request');

      const vllmBody = await transformRequest(request.body);
      const vllmUrl = await getVllmUrl();

      fastify.log.info({ url: vllmUrl, model: vllmBody.model }, '[AI Proxy] Calling vLLM');

      const response = await fetchWithTimeout(vllmUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

      // Increment usage counter for authenticated users
      if (request.user?.id) {
        await incrementUsage(request.user.id, 'ai_analysis', 1);
      }

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
