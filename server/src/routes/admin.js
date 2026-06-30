// ─── Administration Routing ──────────────────────────────────
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { PrismaClient } = require('@prisma/client');
const { resetDeviceBinding } = require('../services/deviceService');
const { processRefund } = require('../services/razorpayService');
const { ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

const router = express.Router();
const prisma = new PrismaClient();

// Enforce auth & admin requirements globally on this router
router.use(requireAuth);
router.use(requireAdmin);

/**
 * GET /admin/dashboard
 * Aggregates site metrics.
 */
router.get('/dashboard', async (req, res, next) => {
  try {
    const totalUsers = await prisma.user.count();
    const blockedUsers = await prisma.user.count({ where: { isBlocked: true } });
    
    // Sum total successful recharges
    const revenueSum = await prisma.payment.aggregate({
      where: { status: 'paid' },
      _sum: { amountPaise: true }
    });

    const activeSessions = await prisma.session.count({
      where: { expiresAt: { gt: new Date() } }
    });

    const totalUsageLogs = await prisma.usageLog.count();
    const failedUsageLogs = await prisma.usageLog.count({ where: { success: false } });

    // Recent 5 audit logs
    const recentAudits = await prisma.adminAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5
    });

    res.json({
      success: true,
      metrics: {
        totalUsers,
        blockedUsers,
        revenueINR: (revenueSum._sum.amountPaise || 0) / 100,
        activeSessions,
        totalRequests: totalUsageLogs,
        failedRequests: failedUsageLogs
      },
      recentAudits
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/users
 * Search and paginate users list.
 */
router.get('/users', async (req, res, next) => {
  try {
    const { query, limit = 20, page = 1 } = req.query;
    const skip = (page - 1) * limit;

    const whereClause = query ? {
      OR: [
        { email: { contains: query, mode: 'insensitive' } },
        { name: { contains: query, mode: 'insensitive' } }
      ]
    } : {};

    const [users, totalCount] = await prisma.$transaction([
      prisma.user.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(skip),
        select: {
          id: true,
          email: true,
          name: true,
          tier: true,
          walletBalancePaise: true,
          freeTrialRequests: true,
          freeTrialUsed: true,
          deviceFingerprint: true,
          isBlocked: true,
          isAdmin: true,
          lastLoginAt: true,
          createdAt: true
        }
      }),
      prisma.user.count({ where: whereClause })
    ]);

    res.json({
      success: true,
      users,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      currentPage: parseInt(page)
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/users/block
 * Suspends or activates a user.
 */
router.post('/users/block', async (req, res, next) => {
  try {
    const { userId, block } = req.body;
    if (!userId) throw new ValidationError('UserId is required');

    const user = await prisma.user.update({
      where: { id: userId },
      data: { isBlocked: !!block }
    });

    // Invalidate user sessions if blocking
    if (block) {
      await prisma.session.deleteMany({ where: { userId } });
    }

    await prisma.adminAuditLog.create({
      data: {
        adminEmail: req.user.email,
        action: block ? 'block_user' : 'unblock_user',
        targetId: userId,
        details: `${block ? 'Blocked' : 'Unblocked'} account for email ${user.email}`
      }
    });

    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/users/reset-device
 * Resets user's machine fingerprint mapping.
 */
router.post('/users/reset-device', async (req, res, next) => {
  try {
    const { userId } = req.body;
    if (!userId) throw new ValidationError('UserId is required');

    const result = await resetDeviceBinding(userId, req.user.email);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/users/manual-credit
 * Grants balance manually.
 */
router.post('/users/manual-credit', async (req, res, next) => {
  try {
    const { userId, amountPaise, reason } = req.body;
    if (!userId || !amountPaise) throw new ValidationError('UserId and amount are required');

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        walletBalancePaise: { increment: parseInt(amountPaise) }
      }
    });

    await prisma.adminAuditLog.create({
      data: {
        adminEmail: req.user.email,
        action: 'manual_credit',
        targetId: userId,
        details: `Credited ₹${(amountPaise / 100).toFixed(2)}: ${reason || 'Manual Adjustment'}`
      }
    });

    res.json({
      success: true,
      newBalancePaise: user.walletBalancePaise,
      message: 'Wallet balance updated successfully'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/users/refund
 * Initiates Razorpay payment refund.
 */
router.post('/users/refund', async (req, res, next) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) throw new ValidationError('PaymentId is required');

    const result = await processRefund(paymentId, req.user.email);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
