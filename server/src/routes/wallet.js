// ─── Wallet & Payment Routing ────────────────────────────────
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimit');
const razorpayService = require('../services/razorpayService');
const walletService = require('../services/walletService');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

/**
 * GET /wallet/balance
 * Returns the logged-in user's wallet balance.
 */
router.get('/balance', requireAuth, async (req, res, next) => {
  try {
    const balanceInfo = await walletService.getBalance(req.user.id);
    res.json({ success: true, ...balanceInfo });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /wallet/tiers
 * Returns available wallet recharge levels.
 */
router.get('/tiers', (req, res) => {
  res.json({ success: true, tiers: walletService.getRechargeTiers() });
});

/**
 * POST /wallet/order
 * Creates a new Razorpay payment order.
 */
router.post('/order', requireAuth, paymentLimiter, async (req, res, next) => {
  try {
    const { amountPaise } = req.body;
    if (!amountPaise) {
      return res.status(400).json({ success: false, error: 'Recharge amount is required' });
    }

    const orderDetails = await razorpayService.createOrder(req.user.id, amountPaise);
    res.json({ success: true, order: orderDetails });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /wallet/verify
 * Validates the completed payment signature and credits the wallet.
 */
router.post('/verify', requireAuth, paymentLimiter, async (req, res, next) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ 
        success: false, 
        error: 'OrderId, PaymentId and Signature are required for verification.' 
      });
    }

    const result = await razorpayService.verifyPayment(
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /wallet/history
 * Fetch past transaction logs.
 */
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const payments = await razorpayService.getPaymentHistory(req.user.id);
    res.json({ success: true, payments });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /wallet/web-order
 * Public checkout endpoint for the website landing page.
 */
router.post('/web-order', paymentLimiter, async (req, res, next) => {
  try {
    const { email, amountPaise } = req.body;
    if (!email || !amountPaise) {
      return res.status(400).json({ success: false, error: 'Email and recharge amount are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email address' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    let user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      // Auto-create account so user gets credits when they first sign in to the app
      user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          name: normalizedEmail.split('@')[0],
          walletBalancePaise: 0,
        }
      });
    }

    const orderDetails = await razorpayService.createOrder(user.id, amountPaise);
    res.json({ success: true, order: orderDetails });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /wallet/web-verify
 * Public verification endpoint for the website landing page.
 */
router.post('/web-verify', paymentLimiter, async (req, res, next) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ 
        success: false, 
        error: 'OrderId, PaymentId and Signature are required for verification.' 
      });
    }

    const result = await razorpayService.verifyPayment(
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
