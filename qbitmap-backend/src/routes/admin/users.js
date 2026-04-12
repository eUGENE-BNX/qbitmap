const db = require('../../services/database');
const { invalidateUserVersionCache } = require('../../utils/jwt');
const { validateBody, userOverridesSchema, adminUpdateUserSchema, adminPlanSchema, parseId } = require('../../utils/validation');

module.exports = async function(fastify) {

  // ==================== DASHBOARD ====================

  /**
   * GET /api/admin/stats
   * Get admin dashboard statistics
   */
  fastify.get('/stats', async (request, reply) => {
    const stats = await db.getAdminStats();
    return stats;
  });

  // ==================== USER MANAGEMENT ====================

  /**
   * GET /api/admin/users
   * List all users with pagination and filtering
   */
  fastify.get('/users', async (request, reply) => {
    const { page = 1, limit = 20, plan_id, role, is_active, search } = request.query;

    const filters = {};
    if (plan_id) filters.plan_id = parseInt(plan_id);
    if (role) filters.role = role;
    if (is_active !== undefined) filters.is_active = is_active === 'true' || is_active === '1';
    if (search) filters.search = search;

    const result = await db.getAllUsersPaginated(parseInt(page), parseInt(limit), filters);
    return result;
  });

  /**
   * GET /api/admin/users/:userId
   * Get detailed user info
   */
  fastify.get('/users/:userId', async (request, reply) => {
    const { userId } = request.params;
    const user = await db.getUserDetail(parseInt(userId));

    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    return user;
  });

  /**
   * PUT /api/admin/users/:userId
   * Update user (plan, role, active status, notes)
   */
  fastify.put('/users/:userId', {
    preHandler: validateBody(adminUpdateUserSchema)
  }, async (request, reply) => {
    const { userId } = request.params;
    const { plan_id, role, is_active, notes } = request.body;

    const user = await db.getUserById(parseInt(userId));
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    // Don't allow modifying own admin status
    if (parseInt(userId) === request.user.userId && role && role !== 'admin') {
      return reply.code(400).send({ error: 'Cannot remove your own admin role' });
    }

    // Update plan
    if (plan_id !== undefined) {
      const plan = await db.getPlanById(parseInt(plan_id));
      if (!plan) {
        return reply.code(400).send({ error: 'Invalid plan ID' });
      }
      await db.updateUserPlan(parseInt(userId), parseInt(plan_id));
    }

    // Update role
    if (role !== undefined) {
      const validRoles = ['user', 'admin'];
      if (!validRoles.includes(role)) {
        return reply.code(400).send({ error: 'Invalid role. Must be: user or admin' });
      }
      const result = await db.updateUserRole(parseInt(userId), role);
      if (!result.success) {
        return reply.code(400).send({ error: result.error });
      }
      // [ARCH-02] updateUserRole bumps token_version in DB; drop the
      // local version cache so this worker revokes the old JWT immediately.
      invalidateUserVersionCache(parseInt(userId));
    }

    // Update active status
    if (is_active !== undefined) {
      await db.setUserActive(parseInt(userId), is_active);
      // [SEC-01] Deactivation bumps token_version in DB; drop local cache so
      // this worker sees the revocation on the very next request.
      if (!is_active) {
        invalidateUserVersionCache(parseInt(userId));
      }
    }

    // Update notes
    if (notes !== undefined) {
      await db.updateUserNotes(parseInt(userId), notes);
    }

    // Return updated user
    return await db.getUserDetail(parseInt(userId));
  });

  // [ARCH-15] DELETE /api/admin/users/:userId removed — it was a misleading
  // REST endpoint that didn't actually delete, just called setUserActive(false).
  // PUT /api/admin/users/:userId with { is_active: false } does the same thing
  // with correct HTTP semantics. No frontend caller existed.

  // ==================== USER OVERRIDES ====================

  /**
   * PUT /api/admin/users/:userId/overrides
   * Set user feature overrides
   */
  fastify.put('/users/:userId/overrides', {
    preHandler: validateBody(userOverridesSchema)
  }, async (request, reply) => {
    const { userId } = request.params;
    const overrides = request.body;

    const user = await db.getUserById(parseInt(userId));
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const result = await db.setUserOverrides(parseInt(userId), overrides);

    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    // Return updated limits
    const limits = await db.getUserEffectiveLimits(parseInt(userId));
    return { success: true, limits };
  });

  /**
   * DELETE /api/admin/users/:userId/overrides
   * Clear all user overrides (revert to plan defaults)
   */
  fastify.delete('/users/:userId/overrides', async (request, reply) => {
    const { userId } = request.params;

    const user = await db.getUserById(parseInt(userId));
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    await db.clearUserOverrides(parseInt(userId));

    // Return updated limits
    const limits = await db.getUserEffectiveLimits(parseInt(userId));
    return { success: true, limits };
  });

  // ==================== PLAN MANAGEMENT ====================

  /**
   * GET /api/admin/plans
   * List all plans
   */
  fastify.get('/plans', async (request, reply) => {
    const plans = await db.getAllPlans();

    // [PERF] Single query for all user counts instead of N+1
    const userCounts = await db.getPlanUserCounts();

    // Build lookup map
    const countMap = new Map(userCounts.map(uc => [uc.plan_id, uc.count]));

    // Add user count to each plan
    const plansWithCounts = plans.map(plan => ({
      ...plan,
      user_count: countMap.get(plan.id) || 0
    }));

    return plansWithCounts;
  });

  /**
   * GET /api/admin/plans/:planId
   * Get plan details
   */
  fastify.get('/plans/:planId', async (request, reply) => {
    const { planId } = request.params;
    const plan = await db.getPlanById(parseInt(planId));

    if (!plan) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    // Add user count
    const userCount = await db.getPlanUserCount(plan.id);

    return { ...plan, user_count: userCount };
  });

  /**
   * POST /api/admin/plans
   * Create a new plan
   */
  fastify.post('/plans', {
    preHandler: validateBody(adminPlanSchema)
  }, async (request, reply) => {
    const planData = request.body;

    // Check if name already exists
    const existing = await db.getPlanByName(planData.name);
    if (existing) {
      return reply.code(400).send({ error: 'Plan name already exists' });
    }

    const result = await db.createPlan(planData);

    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    const plan = await db.getPlanById(result.planId);
    return { success: true, plan };
  });

  /**
   * PUT /api/admin/plans/:planId
   * Update a plan
   */
  fastify.put('/plans/:planId', {
    preHandler: validateBody(adminPlanSchema)
  }, async (request, reply) => {
    const { planId } = request.params;
    const planData = request.body;

    const plan = await db.getPlanById(parseInt(planId));
    if (!plan) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    // Don't allow changing the name of default plans
    if (planId <= 4 && planData.name && planData.name !== plan.name) {
      return reply.code(400).send({ error: 'Cannot change name of default plans' });
    }

    const result = await db.updatePlan(parseInt(planId), planData);

    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    return { success: true, plan: await db.getPlanById(parseInt(planId)) };
  });

  /**
   * DELETE /api/admin/plans/:planId
   * Delete a plan
   */
  fastify.delete('/plans/:planId', async (request, reply) => {
    const { planId } = request.params;

    const result = await db.deletePlan(parseInt(planId));

    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    return { success: true };
  });
};
