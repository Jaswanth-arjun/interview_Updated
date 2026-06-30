// ─── Razorpay Service ────────────────────────────────────────
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const config = require('../config');
const { ValidationError, AppError } = require('../utils/errors');
const walletService = require('./walletService');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

let razorpay = null;
try {
  if (config.razorpay.keyId && !config.razorpay.keyId.startsWith('rzp_test_xxxx')) {
    razorpay = new Razorpay({
      key_id: config.razorpay.keyId,
      key_secret: config.razorpay.keySecret,
    });
    logger.info('✓ Razorpay initialized');
  } else {
    logger.warn('⚠ Razorpay not configured — payment features disabled');
  }
} catch (err) {
  logger.error('Failed to initialize Razorpay:', err);
}

/**
 * Create a Razorpay order for wallet recharge.
 */
async function createOrder(userId, amountPaise) {
  if (!razorpay) {
    throw new AppError('Payment system is not configured', 503);
  }

  if (amountPaise < config.pricing.minRecharge) {
    throw new ValidationError(
      `Minimum recharge amount is ₹${(config.pricing.minRecharge / 100).toFixed(0)}`
    );
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ValidationError('User not found');

  // Create Razorpay order
  const order = await razorpay.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt: `rcpt_${userId.substring(0, 8)}_${Date.now()}`,
    notes: {
      userId: userId,
      email: user.email,
    },
  });

  // Save order in database
  await prisma.payment.create({
    data: {
      userId,
      razorpayOrderId: order.id,
      amountPaise: amountPaise,
      currency: 'INR',
      status: 'created',
    },
  });

  logger.info(`Payment order created: ${order.id} for ₹${(amountPaise / 100).toFixed(2)} (user: ${user.email})`);

  return {
    orderId: order.id,
    amount: amountPaise,
    currency: 'INR',
    keyId: config.razorpay.keyId,
    userName: user.name || '',
    userEmail: user.email,
  };
}

/**
 * Verify Razorpay payment signature and credit the wallet.
 */
async function verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature) {
  if (!razorpay) {
    throw new AppError('Payment system is not configured', 503);
  }

  // Find the order in DB
  const payment = await prisma.payment.findUnique({
    where: { razorpayOrderId },
  });

  if (!payment) {
    throw new ValidationError('Payment order not found');
  }

  if (payment.status === 'paid') {
    logger.warn(`Duplicate payment verification for order ${razorpayOrderId}`);
    return { success: true, alreadyProcessed: true };
  }

  // Verify signature
  const expectedSignature = crypto
    .createHmac('sha256', config.razorpay.keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (expectedSignature !== razorpaySignature) {
    // Mark payment as failed
    await prisma.payment.update({
      where: { razorpayOrderId },
      data: { status: 'failed', razorpayPaymentId },
    });
    logger.error(`Payment signature mismatch for order ${razorpayOrderId}`);
    throw new ValidationError('Payment verification failed. Signature mismatch.');
  }

  // Fetch payment details from Razorpay
  let paymentDetails;
  try {
    paymentDetails = await razorpay.payments.fetch(razorpayPaymentId);
  } catch {
    paymentDetails = {};
  }

  // Update payment record
  await prisma.payment.update({
    where: { razorpayOrderId },
    data: {
      razorpayPaymentId,
      razorpaySignature,
      status: 'paid',
      method: paymentDetails.method || null,
      verifiedAt: new Date(),
    },
  });

  // Credit wallet
  const newBalance = await walletService.addCredits(payment.userId, payment.amountPaise);

  logger.info(`Payment verified: ${razorpayPaymentId} → ₹${(payment.amountPaise / 100).toFixed(2)} credited to user ${payment.userId}`);

  return {
    success: true,
    amountPaise: payment.amountPaise,
    newBalancePaise: newBalance,
  };
}

/**
 * Handle Razorpay webhook events (payment.captured, payment.failed, refund.created).
 */
async function handleWebhook(body, signature) {
  // Verify webhook signature
  const expectedSignature = crypto
    .createHmac('sha256', config.razorpay.webhookSecret)
    .update(JSON.stringify(body))
    .digest('hex');

  if (expectedSignature !== signature) {
    logger.error('Webhook signature verification failed');
    throw new ValidationError('Invalid webhook signature');
  }

  const event = body.event;
  const paymentEntity = body.payload?.payment?.entity;

  logger.info(`Razorpay webhook received: ${event}`);

  if (event === 'payment.captured' && paymentEntity) {
    const orderId = paymentEntity.order_id;
    const payment = await prisma.payment.findUnique({
      where: { razorpayOrderId: orderId },
    });

    if (payment && payment.status !== 'paid') {
      await prisma.payment.update({
        where: { razorpayOrderId: orderId },
        data: {
          razorpayPaymentId: paymentEntity.id,
          status: 'paid',
          method: paymentEntity.method,
          verifiedAt: new Date(),
        },
      });
      await walletService.addCredits(payment.userId, payment.amountPaise);
      logger.info(`Webhook: Payment captured and credited: ${paymentEntity.id}`);
    }
  } else if (event === 'payment.failed' && paymentEntity) {
    const orderId = paymentEntity.order_id;
    await prisma.payment.updateMany({
      where: { razorpayOrderId: orderId, status: 'created' },
      data: { status: 'failed', razorpayPaymentId: paymentEntity.id },
    });
    logger.warn(`Webhook: Payment failed: ${paymentEntity.id}`);
  } else if (event === 'refund.created') {
    const refundEntity = body.payload?.refund?.entity;
    if (refundEntity) {
      const paymentId = refundEntity.payment_id;
      await prisma.payment.updateMany({
        where: { razorpayPaymentId: paymentId },
        data: { status: 'refunded', refundId: refundEntity.id },
      });
      logger.info(`Webhook: Refund processed: ${refundEntity.id}`);
    }
  }

  return { received: true };
}

/**
 * Get payment history for a user.
 */
async function getPaymentHistory(userId, limit = 20) {
  return prisma.payment.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      amountPaise: true,
      currency: true,
      status: true,
      method: true,
      createdAt: true,
      verifiedAt: true,
    },
  });
}

/**
 * Process refund (admin only).
 */
async function processRefund(paymentId, adminEmail) {
  if (!razorpay) throw new AppError('Payment system is not configured', 503);

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
  });

  if (!payment || payment.status !== 'paid') {
    throw new ValidationError('Payment not found or not eligible for refund');
  }

  const refund = await razorpay.payments.refund(payment.razorpayPaymentId, {
    amount: payment.amountPaise,
    speed: 'normal',
  });

  await prisma.payment.update({
    where: { id: paymentId },
    data: { status: 'refunded', refundId: refund.id },
  });

  // Deduct from wallet
  await prisma.user.update({
    where: { id: payment.userId },
    data: {
      walletBalancePaise: { decrement: payment.amountPaise },
    },
  });

  // Audit log
  await prisma.adminAuditLog.create({
    data: {
      adminEmail,
      action: 'refund',
      targetId: payment.userId,
      details: `Refunded ₹${(payment.amountPaise / 100).toFixed(2)} — Razorpay refund: ${refund.id}`,
    },
  });

  logger.info(`Refund processed by ${adminEmail}: ₹${(payment.amountPaise / 100).toFixed(2)} for payment ${paymentId}`);

  return { refundId: refund.id };
}

module.exports = {
  createOrder,
  verifyPayment,
  handleWebhook,
  getPaymentHistory,
  processRefund,
};
